# BRUCE Disk Scanner v6.0 - Complete Edition
# Ajouts vs v5: taille par dossier L1, comptage recursif, WWN/UniqueId,
# date derniere modif, profil extensions, espace recuperable, hash signature
param([Parameter(Mandatory=$true)][string]$Position)

Write-Host "=== BRUCE DISK SCANNER v6 ===" -ForegroundColor Cyan
Write-Host "Position: $Position - Scanning..." -ForegroundColor Yellow

$usbDisks = Get-PhysicalDisk | Where-Object { $_.BusType -eq 'USB' }
if (-not $usbDisks) { Write-Host "ERREUR: Aucun disque USB." -ForegroundColor Red; exit 1 }

$results = @()
foreach ($disk in $usbDisks) {
    if ($disk.Size -eq 0) { continue }
    $diskNum = $disk.DeviceId
    $wmi = Get-WmiObject Win32_DiskDrive | Where-Object { $_.Index -eq $diskNum }
    $diskObj = Get-Disk -Number $diskNum
    $partStyle = $diskObj.PartitionStyle
    $parts = Get-Partition -DiskNumber $diskNum -ErrorAction SilentlyContinue
    $vols = @()
    $folderTree = @()
    $bigFiles = @()
    $zfsInfo = $null
    $smartInfo = $null
    $detectedFS = $null
    $folderSizes = @()
    $extensionProfile = @()
    $recoverableSpace = $null
    $newestFile = $null
    $diskSignature = $null

    # === Serial ===
    $serial = ($disk.SerialNumber -replace '\s','')
    if (-not $serial -or $serial -eq '00000000000000000000') { $serial = ($wmi.SerialNumber -replace '\s','') }
    if (-not $serial -or $serial -eq '00000000000000000000') { $serial = ($diskObj.SerialNumber -replace '\s','') }
    $serialSource = if ($serial -and $serial -ne '00000000000000000000') { "detected" } else { "unavailable_via_usb" }

    # === WWN / UniqueId (plus fiable que serial USB) ===
    $wwn = $diskObj.UniqueId
    $diskSignature = $diskObj.Signature

    # === Volumes Windows (methode v2 originale) ===
    foreach ($p in $parts) {
        $v = Get-Volume -Partition $p -ErrorAction SilentlyContinue
        if (-not $v -or -not $v.DriveLetter) {
            if ($p.DriveLetter -and $p.DriveLetter -ne [char]0) {
                $v = Get-Volume -DriveLetter $p.DriveLetter -ErrorAction SilentlyContinue
            }
        }
        if ($v -and $v.DriveLetter) {
            $letter = $v.DriveLetter
            $vols += [PSCustomObject]@{
                DriveLetter = $letter; Label = $v.FileSystemLabel; FileSystem = $v.FileSystem
                SizeGB = [math]::Round($v.Size / 1GB, 2); FreeGB = [math]::Round($v.SizeRemaining / 1GB, 2)
            }

            # === Dossiers niveau 1 avec TAILLE + comptage recursif ===
            $dirs1 = Get-ChildItem "${letter}:\" -Directory -ErrorAction SilentlyContinue
            foreach ($d1 in $dirs1) {
                $sub = Get-ChildItem $d1.FullName -Directory -ErrorAction SilentlyContinue
                $subFiles = (Get-ChildItem $d1.FullName -File -ErrorAction SilentlyContinue | Measure-Object).Count
                $subNames = ($sub.Name) -join ", "
                $folderTree += "${letter}:\$($d1.Name) ($subFiles files, $($sub.Count) subdirs: $subNames)"
                # Niveau 2: lister les sous-dossiers avec leurs propres sous-dossiers
                foreach ($d2 in $sub) {
                    $sub2 = Get-ChildItem $d2.FullName -Directory -ErrorAction SilentlyContinue
                    $sub2Files = (Get-ChildItem $d2.FullName -File -ErrorAction SilentlyContinue | Measure-Object).Count
                    $sub2Names = ($sub2.Name) -join ", "
                    $folderTree += "  ${letter}:\$($d1.Name)\$($d2.Name) ($sub2Files files, $($sub2.Count) subdirs: $sub2Names)"
                }

                # Taille recursive du dossier
                Write-Host "  Mesurant $($d1.Name)..." -ForegroundColor DarkGray -NoNewline
                $allFiles = Get-ChildItem $d1.FullName -File -Recurse -ErrorAction SilentlyContinue
                $dirSizeBytes = ($allFiles | Measure-Object -Property Length -Sum).Sum
                $dirSizeGB = [math]::Round($dirSizeBytes / 1GB, 2)
                $totalFiles = $allFiles.Count
                $totalSubdirs = (Get-ChildItem $d1.FullName -Directory -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
                Write-Host " ${dirSizeGB}GB ($totalFiles fichiers)" -ForegroundColor DarkGray

                $folderSizes += [PSCustomObject]@{
                    Path = "${letter}:\$($d1.Name)"
                    SizeGB = $dirSizeGB
                    SizeBytes = [long]$dirSizeBytes
                    TotalFiles = $totalFiles
                    TotalSubdirs = $totalSubdirs
                }
            }

            # === Top 10 gros fichiers ===
            $allDiskFiles = Get-ChildItem "${letter}:\" -File -Recurse -ErrorAction SilentlyContinue
            $big = $allDiskFiles | Sort-Object Length -Descending | Select-Object -First 10
            foreach ($f in $big) { $bigFiles += "$([math]::Round($f.Length/1MB))MB - $($f.FullName.Substring(3))" }

            # === Fichier le plus recent (date derniere activite) ===
            $newest = $allDiskFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($newest) {
                $newestFile = [PSCustomObject]@{
                    Path = $newest.FullName.Substring(3)
                    Date = $newest.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
                    SizeMB = [math]::Round($newest.Length / 1MB, 1)
                }
            }

            # === Profil extensions (top 10 par taille totale) ===
            Write-Host "  Profil extensions..." -ForegroundColor DarkGray
            $extGroups = $allDiskFiles | Group-Object { $_.Extension.ToLower() } |
                ForEach-Object {
                    $totalSize = ($_.Group | Measure-Object -Property Length -Sum).Sum
                    [PSCustomObject]@{
                        Extension = if ($_.Name) { $_.Name } else { "(sans ext)" }
                        Count = $_.Count
                        TotalGB = [math]::Round($totalSize / 1GB, 2)
                        TotalBytes = [long]$totalSize
                    }
                } | Sort-Object TotalBytes -Descending | Select-Object -First 10

            $usedBytes = ($allDiskFiles | Measure-Object -Property Length -Sum).Sum
            foreach ($eg in $extGroups) {
                $pct = if ($usedBytes -gt 0) { [math]::Round($eg.TotalBytes / $usedBytes * 100, 1) } else { 0 }
                $extensionProfile += [PSCustomObject]@{
                    Extension = $eg.Extension; Count = $eg.Count; TotalGB = $eg.TotalGB; Percent = $pct
                }
            }

            # === Espace recuperable (fichiers temporaires/inutiles) ===
            Write-Host "  Espace recuperable..." -ForegroundColor DarkGray
            $junkPatterns = @('Thumbs.db', 'desktop.ini', '.DS_Store', '*.tmp', '*.bak', '*.log')
            $junkDirs = @('.deletedByTMM', '$RECYCLE.BIN', 'System Volume Information', '.Trashes', '.Spotlight-V100')
            $junkSize = 0; $junkCount = 0
            foreach ($jd in $junkDirs) {
                $jdPath = "${letter}:\$jd"
                try {
                    if (Test-Path $jdPath -ErrorAction SilentlyContinue) {
                        $jdFiles = Get-ChildItem $jdPath -File -Recurse -Force -ErrorAction SilentlyContinue
                        $jdSize = ($jdFiles | Measure-Object -Property Length -Sum).Sum
                        $junkSize += $jdSize; $junkCount += $jdFiles.Count
                    }
                } catch { <# ignore access denied #> }
            }
            foreach ($jp in $junkPatterns) {
                $jpFiles = Get-ChildItem "${letter}:\" -Filter $jp -File -Recurse -ErrorAction SilentlyContinue
                $jpSize = ($jpFiles | Measure-Object -Property Length -Sum).Sum
                $junkSize += $jpSize; $junkCount += $jpFiles.Count
            }
            $recoverableSpace = [PSCustomObject]@{
                TotalMB = [math]::Round($junkSize / 1MB, 1)
                TotalGB = [math]::Round($junkSize / 1GB, 2)
                FileCount = $junkCount
                Details = "Thumbs.db, desktop.ini, .DS_Store, .tmp, .bak, .log, .deletedByTMM, RECYCLE.BIN, System Volume Information"
            }
        }
    }

    # === ZFS detection (identique v5) ===
    $GPT_FREEBSD_ZFS = '{516e7cba-6ecf-11d6-8ff8-00022d09712b}'
    if ($partStyle -eq 'RAW' -or ($vols.Count -eq 0)) {
        $drivePath = "\\.\PhysicalDrive$diskNum"
        $zfsOffsets = @(16384)
        if ($parts) {
            foreach ($p in $parts) {
                if ("$($p.GptType)" -eq $GPT_FREEBSD_ZFS) {
                    $detectedFS = "FreeBSD/ZFS"
                    $zfsOffsets = @($p.Offset, ($p.Offset + 16384))
                }
            }
        }
        # Detection ext4 pour GPT Linux
        $GPT_LINUX = '{0fc63daf-8483-4772-8e79-3d69d8477de4}'
        if ($parts) {
            foreach ($p in $parts) {
                if ("$($p.GptType)" -eq $GPT_LINUX) {
                    $detectedFS = "ext4 (Linux)"
                }
            }
        }
        foreach ($tryOffset in $zfsOffsets) {
            try {
                $stream = [System.IO.File]::Open($drivePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $stream.Seek($tryOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
                $buf = New-Object byte[] 32768
                $stream.Read($buf, 0, 32768) | Out-Null
                $stream.Close()
                $clean = [System.Text.Encoding]::ASCII.GetString(($buf | Where-Object { $_ -ne 0 }))
                $readable = ($clean -replace '[^\x20-\x7E]', ' ') -replace '\s{2,}', ' '
                if ($readable -match 'name\s+\S+' -and $readable -match 'hostname|pool_guid') {
                    $poolName = if ($readable -match 'name\s+(\S+)') { $Matches[1] -replace '[^\w\-]','' } else { $null }
                    $hostname = if ($readable -match 'hostname\s+(\S+)') { $Matches[1] -replace '[^\w\-]','' } else { $null }
                    $vdevType = if ($readable -match 'type\s+(raidz\d?|mirror|disk|stripe)') { $Matches[1] } else { $null }
                    $devPath = if ($readable -match '(\/dev\/\w+)') { $Matches[1] } else { $null }
                    $nparityVal = switch -Wildcard ($vdevType) { 'raidz3'{3}; 'raidz2'{2}; 'raidz*'{1}; default{$null} }
                    $ashiftVal = $null
                    $ashiftIdx = [System.Text.Encoding]::ASCII.GetString($buf).IndexOf("ashift")
                    if ($ashiftIdx -ge 0) { for ($off=$ashiftIdx+6; $off -lt $ashiftIdx+40; $off++) { if ($buf[$off] -ge 9 -and $buf[$off] -le 16) { $ashiftVal=[int]$buf[$off]; break } } }
                    $isDegraded = $readable -match 'degraded'
                    $errExceeded = $readable -match 'err_exceeded'
                    $allPaths = [regex]::Matches($readable, '/dev/[\w/\-]+') | ForEach-Object { $_.Value } | Select-Object -Unique
                    $allSerials = [regex]::Matches($readable, 'ata-([A-Za-z0-9_\-]+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
                    $allSlots = [regex]::Matches($readable, 'slot@(\d+)') | ForEach-Object { "slot$($_.Groups[1].Value)" } | Select-Object -Unique
                    $diskCount = ($allPaths | Where-Object { $_ -match '^/dev/sd|^/dev/disk' }).Count
                    $parityStr = if ($nparityVal) { "RAIDZ$nparityVal" } else { if ($vdevType) { $vdevType.ToUpper() } else { "?" } }
                    $detectedFS = "ZFS"
                    $zfsInfo = [PSCustomObject]@{
                        PoolName=$poolName; Hostname=$hostname; VdevType=$vdevType; Nparity=$nparityVal
                        Ashift=$ashiftVal; DiskCount=$diskCount; OriginalPath=$devPath; AllDiskPaths=$allPaths
                        AllSerials=$allSerials; AllSlots=$allSlots; IsDegraded=$isDegraded; ErrExceeded=$errExceeded
                        ThisDiskSerial=($allSerials | Select-Object -First 1)
                        PoolCompatibility="$parityStr - ashift=$(if($ashiftVal){$ashiftVal}else{'?'}) - $diskCount disques dans le vdev"
                        RawStrings=$readable.Substring(0,[math]::Min(1200,$readable.Length))
                    }
                    Write-Host "  ZFS: $poolName ($parityStr, ashift=$ashiftVal)" -ForegroundColor Green
                    if ($isDegraded) { Write-Host "  !! DEGRADED" -ForegroundColor Red }
                    if ($errExceeded) { Write-Host "  !! err_exceeded" -ForegroundColor Red }
                    break
                }
            } catch {}
        }
        if (-not $detectedFS) {
            try {
                $stream = [System.IO.File]::Open($drivePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $stream.Seek(1024, [System.IO.SeekOrigin]::Begin) | Out-Null
                $extBuf = New-Object byte[] 512; $stream.Read($extBuf, 0, 512) | Out-Null
                $stream.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
                $hdrBuf = New-Object byte[] 512; $stream.Read($hdrBuf, 0, 512) | Out-Null
                $stream.Close()
                if ([BitConverter]::ToUInt16($extBuf, 0x38) -eq 0xEF53) { $detectedFS = "ext4" }
                elseif (($hdrBuf | Where-Object { $_ -ne 0 }).Count -eq 0) { $detectedFS = "VIERGE" }
                else { $detectedFS = "INCONNU" }
            } catch { $detectedFS = "ERREUR" }
        }
    }

    # === SMART ===
    try {
        $smartData = Get-PhysicalDisk -DeviceNumber $diskNum | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
        if ($smartData) {
            $powerYears = if ($smartData.PowerOnHours) { [math]::Round($smartData.PowerOnHours / 8760, 1) } else { $null }
            $smartInfo = [PSCustomObject]@{
                Temperature=$smartData.Temperature; PowerOnHours=$smartData.PowerOnHours; PowerOnYears=$powerYears
                ReadErrorsTotal=$smartData.ReadErrorsTotal; ReadErrorsCorrected=$smartData.ReadErrorsCorrected
                ReadErrorsUncorrected=$smartData.ReadErrorsUncorrected
                WriteErrorsTotal=$smartData.WriteErrorsTotal; WriteErrorsCorrected=$smartData.WriteErrorsCorrected
                WriteErrorsUncorrected=$smartData.WriteErrorsUncorrected
                Wear=$smartData.Wear; StartStopCycleCount=$smartData.StartStopCycleCount
                LoadUnloadCycleCount=$smartData.LoadUnloadCycleCount
                ReadLatencyMax=$smartData.ReadLatencyMax; WriteLatencyMax=$smartData.WriteLatencyMax
            }
            $uncR = if ($smartData.ReadErrorsUncorrected) { $smartData.ReadErrorsUncorrected } else { 0 }
            $uncW = if ($smartData.WriteErrorsUncorrected) { $smartData.WriteErrorsUncorrected } else { 0 }
            Write-Host "  SMART: ${powerYears}ans, ${uncR}R/${uncW}W erreurs, $($smartData.Temperature)C" -ForegroundColor $(if ($uncR+$uncW -gt 0) {'Red'} else {'Green'})
        } else {
            $smartInfo = [PSCustomObject]@{ Available=$false; Reason="Non disponible via USB" }
            Write-Host "  SMART: Non disponible via USB" -ForegroundColor Yellow
        }
    } catch { $smartInfo = [PSCustomObject]@{ Available=$false; Reason=$_.ToString() } }

    # === Verdict ===
    $verdict = "UTILISABLE"; $verdictDetails = @()
    if ($disk.HealthStatus -ne 'Healthy') { $verdict="SUSPECT"; $verdictDetails += "Health=$($disk.HealthStatus)" }
    $readUnc = if ($smartInfo.ReadErrorsUncorrected) { $smartInfo.ReadErrorsUncorrected } else { 0 }
    $writeUnc = if ($smartInfo.WriteErrorsUncorrected) { $smartInfo.WriteErrorsUncorrected } else { 0 }
    if ($readUnc -gt 50 -or $writeUnc -gt 50) { $verdict="POUBELLE"; $verdictDetails += "Erreurs=$readUnc R/$writeUnc W (seuil:50)" }
    elseif ($readUnc -gt 0 -or $writeUnc -gt 0) { $verdict="RISQUE"; $verdictDetails += "Erreurs=$readUnc R/$writeUnc W" }
    if ($smartInfo.PowerOnYears -and $smartInfo.PowerOnYears -gt 7) { $verdictDetails += "Vieux(~$($smartInfo.PowerOnYears)ans)" }
    if ($zfsInfo -and $zfsInfo.ErrExceeded) { $verdictDetails += "ZFS err_exceeded" }
    $color = switch ($verdict) { 'UTILISABLE'{'Green'}; 'SUSPECT'{'Yellow'}; 'RISQUE'{'Yellow'}; 'POUBELLE'{'Red'}; default{'White'} }
    Write-Host "  >>> $verdict $(if($verdictDetails){"($($verdictDetails -join ', '))"}) <<<" -ForegroundColor $color

    $results += [PSCustomObject]@{
        Position=$Position; ScanTime=(Get-Date -Format "yyyy-MM-dd HH:mm:ss"); ScriptVersion="6.0"
        Model=$disk.Model; SerialNumber=$serial; SerialSource=$serialSource
        WWN=$wwn; DiskSignature=$diskSignature
        SizeGB=[math]::Round($disk.Size/1GB,2); MediaType=$disk.MediaType
        HealthStatus=$disk.HealthStatus; PartitionStyle=$partStyle; DetectedFS=$detectedFS
        Volumes=($vols|ForEach-Object{"$($_.DriveLetter): '$($_.Label)' [$($_.FileSystem)] $($_.SizeGB)GB (free:$($_.FreeGB)GB)"})-join " | "
        FolderTree=$folderTree; FolderSizes=$folderSizes
        BiggestFiles=$bigFiles; NewestFile=$newestFile
        ExtensionProfile=$extensionProfile; RecoverableSpace=$recoverableSpace
        ZfsInfo=$zfsInfo; SmartInfo=$smartInfo; Verdict=$verdict; VerdictDetails=($verdictDetails -join ', ')
    }
}

$json = $results | ConvertTo-Json -Depth 5
$outFile = "C:\Users\Administrator\Desktop\claude_workspace\disk_scan_$Position.json"
$json | Out-File -FilePath $outFile -Encoding UTF8

Write-Host "`n=== RESULTAT ===" -ForegroundColor Green
$r = $results[0]
Write-Host "Model: $($r.Model) | Serial: $($r.SerialNumber) ($($r.SerialSource))" -ForegroundColor White
Write-Host "WWN: $($r.WWN)" -ForegroundColor White
Write-Host "Size: $($r.SizeGB)GB | Health: $($r.HealthStatus) | Partition: $($r.PartitionStyle) $(if($r.DetectedFS){"[$($r.DetectedFS)]"})" -ForegroundColor White
if ($r.Volumes) { Write-Host "Volumes: $($r.Volumes)" -ForegroundColor White } else { Write-Host "Volumes: (aucun)" -ForegroundColor Yellow }
if ($r.ZfsInfo) { Write-Host "ZFS: $($r.ZfsInfo.PoolName) ($($r.ZfsInfo.ParityStr))" -ForegroundColor Cyan }
if ($r.FolderSizes.Count -gt 0) {
    Write-Host "`nTaille par dossier:" -ForegroundColor Cyan
    $r.FolderSizes | Sort-Object SizeBytes -Descending | ForEach-Object { Write-Host "  $($_.SizeGB)GB`t$($_.TotalFiles) fichiers`t$($_.Path)" }
}
if ($r.ExtensionProfile.Count -gt 0) {
    Write-Host "`nProfil extensions:" -ForegroundColor Cyan
    $r.ExtensionProfile | ForEach-Object { Write-Host "  $($_.Percent)%`t$($_.TotalGB)GB`t$($_.Count) fichiers`t$($_.Extension)" }
}
if ($r.NewestFile) { Write-Host "`nFichier le plus recent: $($r.NewestFile.Date) - $($r.NewestFile.Path)" -ForegroundColor Cyan }
if ($r.RecoverableSpace -and $r.RecoverableSpace.TotalMB -gt 0) {
    Write-Host "`nEspace recuperable: $($r.RecoverableSpace.TotalGB)GB ($($r.RecoverableSpace.FileCount) fichiers)" -ForegroundColor Yellow
}
if ($r.FolderTree.Count -gt 0) { Write-Host "`nDossiers:" -ForegroundColor Cyan; $r.FolderTree | ForEach-Object { Write-Host "  $_" } }
if ($r.BiggestFiles.Count -gt 0) { Write-Host "`nGros fichiers:" -ForegroundColor Cyan; $r.BiggestFiles | ForEach-Object { Write-Host "  $_" } }

$photoDir = "C:\Users\Administrator\Downloads\Telegram Desktop"
$today = Get-Date -Format 'yyyyMMdd'
$photos = Get-ChildItem $photoDir -Filter "IMG_${today}_*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3
if ($photos) { Write-Host "`nPhotos du jour:" -ForegroundColor Magenta; $photos | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Gray } }

Write-Host "`nJSON: $outFile" -ForegroundColor Yellow