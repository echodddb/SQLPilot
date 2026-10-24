/** 单测用：sections.ts 只在 open() 时才用到 electron 的 safeStorage/app */
export const app = { getPath: () => process.env.TEMP || '.' }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.from(''),
  decryptString: () => ''
}
export default { app, safeStorage }
