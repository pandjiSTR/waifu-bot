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

test('loadPersona seeds Redis after reading from file', async () => {
  const freshRedis = createFakeRedis();
  const localContent = await persona.loadPersona(freshRedis);
  const fromRedis = await persona.getPersonaContent(freshRedis);
  assert.strictEqual(fromRedis, localContent);
});

test('getPersonaContent returns empty string when redis is null', async () => {
  const content = await persona.getPersonaContent(null);
  assert.strictEqual(content, '');
});

test('savePersona is a no-op (no throw) when redis is null', async () => {
  await assert.doesNotReject(
    persona.savePersona(null, 'anything')
  );
});

test('save + get persona roundtrip through fake redis', async () => {
  const redis = createFakeRedis();
  const sample = 'Persona: Ara is a helpful assistant.';
  await persona.savePersona(redis, sample);
  const readBack = await persona.getPersonaContent(redis);
  assert.strictEqual(readBack, sample);
});

test('buildSystemPrompt includes Persona section with saved content', async () => {
  const redis = createFakeRedis();
  await persona.savePersona(redis, 'Base persona text');
  const prompt = await persona.buildSystemPrompt(redis);
  assert.match(prompt, /\[SYSTEM: Persona\]/);
  assert.match(prompt, /Base persona text/);
});

test('buildSystemPrompt renders facts array as bullet list', async () => {
  const redis = createFakeRedis();
  await persona.savePersona(redis, 'Base');
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
  const prompt = await persona.buildSystemPrompt(redis);
  assert.doesNotMatch(prompt, /\[Yang Ara inget/);
  assert.doesNotMatch(prompt, /\[Mood Ara/);
});

test('buildSystemPrompt renders context section', async () => {
  const redis = createFakeRedis();
  await persona.savePersona(redis, 'Base');
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
  const prompt = await persona.buildSystemPrompt(redis);
  assert.match(prompt, /Panji/);
  assert.doesNotMatch(prompt, /\{OWNER_NAME\}/);
});

test('buildSystemPrompt includes persona relationship context', async () => {
  const redis = createFakeRedis();
  await persona.loadPersona(redis);
  const prompt = await persona.buildSystemPrompt(redis);
  assert.match(prompt, /Hubungan sama/);
  assert.match(prompt, /pacar/i);
  assert.match(prompt, /NO EMOJI/, 'persona should contain no-emoji rule');
});

test('buildSystemPrompt includes NO EMOJI rule from persona.md', async () => {
  const redis = createFakeRedis();
  await persona.loadPersona(redis);
  const prompt = await persona.buildSystemPrompt(redis);
  assert.match(prompt, /EMOJI/);
});
