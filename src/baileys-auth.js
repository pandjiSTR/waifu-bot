import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys'

const PREFIX = 'waifu:auth:'

export async function useRedisAuthState(redis) {
  const readData = async (id) => {
    const raw = await redis.get(`${PREFIX}${id}`)
    if (!raw) return null
    return JSON.parse(raw, BufferJSON.reviver)
  }

  const writeData = async (data, id) => {
    await redis.set(`${PREFIX}${id}`, JSON.stringify(data, BufferJSON.replacer))
  }

  const removeData = async (id) => {
    await redis.del(`${PREFIX}${id}`)
  }

  const creds = (await readData('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`)
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            data[id] = value
          }))
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const key = `${category}-${id}`
              tasks.push(value ? writeData(value, key) : removeData(key))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, 'creds')
    },
  }
}