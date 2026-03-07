'use strict';
const Docker = require('dockerode');

// Singleton dockerode instance — connects to local Docker socket
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

module.exports = docker;
