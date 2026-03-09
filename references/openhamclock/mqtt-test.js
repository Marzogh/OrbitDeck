const mqtt = require('mqtt');
const c = mqtt.connect('wss://mqtt.pskreporter.info:1886/mqtt', {
  clientId: 'topic_test_' + Math.random().toString(16).substr(2, 6),
  clean: true,
  protocolVersion: 4,
});
c.on('connect', () => {
  console.log('Connected - subscribing...');
  c.subscribe('pskr/filter/v2/20m/FT8/+/+/#');
});
c.on('message', (topic, msg) => {
  const parts = topic.split('/');
  console.log('Topic parts:', parts);
  console.log('  [3] band?:', parts[3]);
  console.log('  [4] mode?:', parts[4]);
  console.log('  [5] sender?:', parts[5]);
  console.log('  [6] receiver?:', parts[6]);
  console.log('  [7] senderGrid?:', parts[7]);
  console.log('  [8] receiverGrid?:', parts[8]);
  console.log('---');
});
setTimeout(() => {
  console.log('Timeout - no spots in 2 min');
  c.end();
}, 120000);
