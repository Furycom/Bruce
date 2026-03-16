const { TOPIC_MAPPING } = require('../../shared/topic-context');

describe('Topic mapping', () => {
  test('known topics resolve to categories', () => {
    expect(TOPIC_MAPPING.dspy.tool_cats).toContain('ai');
    expect(TOPIC_MAPPING.docker.tool_cats).toContain('docker_management');
    expect(TOPIC_MAPPING.infra.kb_tags).toContain('infrastructure');
  });

  test('unknown topics return null (fallback to governance)', () => {
    expect(TOPIC_MAPPING.unknown_topic).toBeUndefined();
    expect(TOPIC_MAPPING['']).toBeUndefined();
  });

  test('topic extraction from compound string', () => {
    const topic = 'dspy optimization run';
    const topicKey = topic.toLowerCase().split(/[\s,]+/)[0];
    expect(topicKey).toBe('dspy');
    expect(TOPIC_MAPPING[topicKey]).toBeDefined();
  });
});
