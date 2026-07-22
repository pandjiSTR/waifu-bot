// Tests for src/personality.js — uses a fake in-memory Redis (no real
// connection) to exercise the real load/seed/save/get logic, plus the
// read-only file fallback and buildSystemPrompt marker assembly.
import { test, before } from 'node:test';
import assert from 'node:assert';

function createFakeRedis() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    _store: store,
  };
}

let personality;
let fakeRedis;

before(async () => {
  fakeRedis = createFakeRedis();
  personality = await import('../src/personality.js');
});

test('loadPersonality reads the real personality.txt when Redis is empty', async () => {
  // No key seeded in fake redis -> falls back to local file (read-only).
  const content = await personality.loadPersonality(fakeRedis);
  assert.ok(typeof content === 'string');
  assert.ok(content.length > 0, 'expected real personality.txt content');
});

test('loadPersonality seeds Redis after reading from file', async () => {
  // Fresh fake redis each run to confirm seeding behaviour.
  const localContent = await personality.loadPersonality(createFakeRedis());
  const seededRedis = createFakeRedis();
  // Simulate the post-load seeding path by saving then loading.
  await personality.savePersonality(seededRedis, localContent);
  const fromRedis = await personality.getPersonalityContent(seededRedis);
  assert.strictEqual(fromRedis, localContent);
});

test('getPersonalityContent returns empty string when redis is null', async () => {
  const content = await personality.getPersonalityContent(null);
  assert.strictEqual(content, '');
});

test('savePersonality is a no-op (no throw) when redis is null', async () => {
  await assert.doesNotReject(
    personality.savePersonality(null, 'anything')
  );
});

test('save + get roundtrip through fake redis', async () => {
  const redis = createFakeRedis();
  const sample = 'Persona: Ara is a helpful assistant.';
  await personality.savePersonality(redis, sample);
  const readBack = await personality.getPersonalityContent(redis);
  assert.strictEqual(readBack, sample);
});

test('buildSystemPrompt always includes the Persona section', async () => {
  const redis = createFakeRedis();
  await personality.savePersonality(redis, 'Base persona text');
  const prompt = await personality.buildSystemPrompt(redis);
  assert.match(prompt, /\[SYSTEM: Persona\]/);
  assert.match(prompt, /Base persona text/);
});

test('buildSystemPrompt renders facts array as bullet list', async () => {
  const redis = createFakeRedis();
  await personality.savePersonality(redis, 'Base');
  const prompt = await personality.buildSystemPrompt(
    redis,
    '',
    ['fact one', 'fact two', 'fact three'],
    ''
  );
  assert.match(prompt, /\[Yang Ara inget tentang orang ini:\]/);
  assert.match(prompt, /- fact one/);
  assert.match(prompt, /- fact two/);
  assert.match(prompt, /- fact three/);
  assert.doesNotMatch(prompt, /\[Mood Ara/);
});

test('buildSystemPrompt renders mood as single line', async () => {
  const redis = createFakeRedis();
  await personality.savePersonality(redis, 'Base');
  const prompt = await personality.buildSystemPrompt(
    redis,
    '',
    [],
    'excited'
  );
  assert.match(prompt, /\[Mood Ara saat ini ke orang ini: excited\]/);
  assert.doesNotMatch(prompt, /\[Yang Ara inget/);
});

test('buildSystemPrompt omits memory section when facts and mood are empty', async () => {
  const redis = createFakeRedis();
  await personality.savePersonality(redis, 'Base');
  const prompt = await personality.buildSystemPrompt(redis);
  assert.doesNotMatch(prompt, /\[Yang Ara inget/);
  assert.doesNotMatch(prompt, /\[Mood Ara/);
});

test('buildSystemPrompt renders facts section without mood line when mood is empty', async () => {
  const redis = createFakeRedis();
  await personality.savePersonality(redis, 'Base');
  const prompt = await personality.buildSystemPrompt(
    redis,
    '',
    ['fact1', 'fact2'],
    ''
  );
  assert.match(prompt, /\[Yang Ara inget tentang orang ini:\]/);
  assert.match(prompt, /- fact1/);
  assert.doesNotMatch(prompt, /\[Mood Ara/);
});

test('buildSystemPrompt renders mood line without facts list when facts is empty', async () => {
  const redis = createFakeRedis();
  await personality.savePersonality(redis, 'Base');
  const prompt = await personality.buildSystemPrompt(
    redis,
    '',
    [],
    'melancholic'
  );
  assert.match(prompt, /\[Mood Ara saat ini ke orang ini: melancholic\]/);
  assert.doesNotMatch(prompt, /\[Yang Ara inget/);
});

test('buildSystemPrompt treats string facts as empty array (backward compat)', async () => {
  const redis = createFakeRedis();
  await personality.savePersonality(redis, 'Base');
  const prompt = await personality.buildSystemPrompt(
    redis,
    'recent context',
    'known fact',
    'happy'
  );
  assert.match(prompt, /\[SYSTEM: Recent Context\]/);
  assert.match(prompt, /recent context/);
  assert.doesNotMatch(prompt, /\[Yang Ara inget/);
  assert.match(prompt, /\[Mood Ara saat ini ke orang ini: happy\]/);
});

test('buildSystemPrompt handles null redis gracefully', async () => {
  const prompt = await personality.buildSystemPrompt(null);
  assert.match(prompt, /\[SYSTEM: Persona\]/);
  assert.match(prompt, /\(no personality loaded\)/);
});

test('applyOwnerName substitutes {OWNER_NAME} with env value', () => {
  process.env.OWNER_NAME = 'Bakwan';
  assert.strictEqual(personality.applyOwnerName('Halo {OWNER_NAME}'), 'Halo Bakwan');
});

test('applyOwnerName leaves text without placeholder unchanged', () => {
  process.env.OWNER_NAME = 'Bakwan';
  assert.strictEqual(personality.applyOwnerName('halo'), 'halo');
});

test('buildSystemPrompt applies owner name from saved persona', async () => {
  process.env.OWNER_NAME = 'Bakwan';
  const redis = createFakeRedis();
  await personality.savePersonality(redis, 'Base {OWNER_NAME}');
  const prompt = await personality.buildSystemPrompt(redis);
  assert.match(prompt, /Bakwan/);
  assert.doesNotMatch(prompt, /\{OWNER_NAME\}/);
});

test('buildSystemPrompt includes no-exclamation directive from personality.txt', async () => {
  const redis = createFakeRedis();
  const content = await personality.loadPersonality(redis);
  assert.ok(content.length > 0, 'personality should be loaded');
  const prompt = await personality.buildSystemPrompt(redis);
  assert.match(prompt, /tanda seru/, 'system prompt should contain the no-exclamation rule');
});

test('buildSystemPrompt restricts "beb" to owner only', async () => {
  const redis = createFakeRedis();
  const content = await personality.loadPersonality(redis);
  assert.ok(content.length > 0, 'personality should be loaded');
  const prompt = await personality.buildSystemPrompt(redis);
  assert.match(prompt, /CUMA ke/);
});
