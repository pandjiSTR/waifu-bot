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

let persona;
let fakeRedis;

before(async () => {
  fakeRedis = createFakeRedis();
  persona = await import('../src/persona.js');
});

test('loadPersona reads the real persona.md when Redis is empty', async () => {
  const content = await persona.loadPersona(fakeRedis);
  assert.ok(typeof content === 'string');
  assert.ok(content.length > 0, 'expected real persona.md content');
  const seeded = fakeRedis._store.get('waifu:persona');
  assert.ok(seeded && seeded.length > 0, 'persona should be seeded to Redis');
});

test('loadRules reads the real rules.md when Redis is empty', async () => {
  const redis = createFakeRedis();
  const content = await persona.loadRules(redis);
  assert.ok(typeof content === 'string');
  assert.ok(content.length > 0, 'expected real rules.md content');
  const seeded = redis._store.get('waifu:rules');
  assert.ok(seeded && seeded.length > 0, 'rules should be seeded to Redis');
});

test('loadPersona seeds Redis after reading from file', async () => {
  const freshRedis = createFakeRedis();
  const localContent = await persona.loadPersona(freshRedis);
  const fromRedis = await persona.getPersonaContent(freshRedis);
  assert.strictEqual(fromRedis, localContent);
});

test('loadRules seeds Redis after reading from file', async () => {
  const freshRedis = createFakeRedis();
  const localContent = await persona.loadRules(freshRedis);
  const fromRedis = await persona.getRulesContent(freshRedis);
  assert.strictEqual(fromRedis, localContent);
});

test('getPersonaContent returns empty string when redis is null', async () => {
  const content = await persona.getPersonaContent(null);
  assert.strictEqual(content, '');
});

test('getRulesContent returns empty string when redis is null', async () => {
  const content = await persona.getRulesContent(null);
  assert.strictEqual(content, '');
});

test('savePersona is a no-op (no throw) when redis is null', async () => {
  await assert.doesNotReject(
    persona.savePersona(null, 'anything')
  );
});

test('saveRules is a no-op (no throw) when redis is null', async () => {
  await assert.doesNotReject(
    persona.saveRules(null, 'anything')
  );
});

test('save + get persona roundtrip through fake redis', async () => {
  const redis = createFakeRedis();
  const sample = 'Persona: Ara is a helpful assistant.';
  await persona.savePersona(redis, sample);
  const readBack = await persona.getPersonaContent(redis);
  assert.strictEqual(readBack, sample);
});

test('save + get rules roundtrip through fake redis', async () => {
  const redis = createFakeRedis();
  const sample = 'Rules: No emoji.';
  await persona.saveRules(redis, sample);
  const readBack = await persona.getRulesContent(redis);
  assert.strictEqual(readBack, sample);
});

test('buildSystemPrompt always includes both Persona and Rules sections', async () => {
  const redis = createFakeRedis();
  await persona.savePersona(redis, 'Base persona text');
  await persona.saveRules(redis, 'Base rules text');
  const prompt = await persona.buildSystemPrompt(redis);
  assert.match(prompt, /\[SYSTEM: Persona\]/);
  assert.match(prompt, /Base persona text/);
  assert.match(prompt, /\[SYSTEM: Rules\]/);
  assert.match(prompt, /Base rules text/);
});

test('buildSystemPrompt renders facts array as bullet list', async () => {
  const redis = createFakeRedis();
  await persona.savePersona(redis, 'Base');
  await persona.saveRules(redis, 'Base rules');
  const prompt = await persona.buildSystemPrompt(
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
  await persona.savePersona(redis, 'Base');
  await persona.saveRules(redis, 'Base rules');
  const prompt = await persona.buildSystemPrompt(
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
  await persona.savePersona(redis, 'Base');
  await persona.saveRules(redis, 'Base rules');
  const prompt = await persona.buildSystemPrompt(redis);
  assert.doesNotMatch(prompt, /\[Yang Ara inget/);
  assert.doesNotMatch(prompt, /\[Mood Ara/);
});

test('buildSystemPrompt renders context section', async () => {
  const redis = createFakeRedis();
  await persona.savePersona(redis, 'Base');
  await persona.saveRules(redis, 'Base rules');
  const prompt = await persona.buildSystemPrompt(redis, 'recent context');
  assert.match(prompt, /\[SYSTEM: Recent Context\]/);
  assert.match(prompt, /recent context/);
});

test('buildSystemPrompt handles null redis gracefully', async () => {
  const prompt = await persona.buildSystemPrompt(null);
  assert.match(prompt, /\[SYSTEM: Persona\]/);
  assert.match(prompt, /\(no personality loaded\)/);
});

test('applyOwnerName substitutes {OWNER_NAME} with env value', () => {
  process.env.OWNER_NAME = 'Panji';
  assert.strictEqual(persona.applyOwnerName('Halo {OWNER_NAME}'), 'Halo Panji');
});

test('applyOwnerName leaves text without placeholder unchanged', () => {
  process.env.OWNER_NAME = 'Panji';
  assert.strictEqual(persona.applyOwnerName('halo'), 'halo');
});

test('buildSystemPrompt applies owner name from saved persona', async () => {
  process.env.OWNER_NAME = 'Panji';
  const redis = createFakeRedis();
  await persona.savePersona(redis, 'Base {OWNER_NAME}');
  await persona.saveRules(redis, 'Some rules');
  const prompt = await persona.buildSystemPrompt(redis);
  assert.match(prompt, /Panji/);
  assert.doesNotMatch(prompt, /\{OWNER_NAME\}/);
});

test('buildSystemPrompt includes no-exclamation directive from persona.md', async () => {
  const redis = createFakeRedis();
  const content = await persona.loadPersona(redis);
  assert.ok(content.length > 0, 'persona should be loaded');
  const prompt = await persona.buildSystemPrompt(redis);
  assert.match(prompt, /tanda seru/, 'system prompt should contain the no-exclamation rule');
});

test('buildSystemPrompt restricts "beb" to owner only', async () => {
  const redis = createFakeRedis();
  const content = await persona.loadPersona(redis);
  assert.ok(content.length > 0, 'persona should be loaded');
  const prompt = await persona.buildSystemPrompt(redis);
  assert.match(prompt, /Panggilan ke/);
});
