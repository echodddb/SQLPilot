import assert from 'node:assert/strict'
import { normalizeConnectionProfile, validateConnectionProfile } from '../src/main/db/connection-profile.ts'

const base = {
  id: 'conn_test',
  name: 'ob-oracle-test',
  type: 'ob-oracle',
  host: 'obproxy.example.com',
  port: 2883,
  user: 'dbadmin',
  role: 'readonly',
  obConnectMode: 'obproxy',
  obTenant: 'biz',
  obCluster: 'prod'
}

assert.equal(validateConnectionProfile(base, true), '')
assert.match(validateConnectionProfile({ ...base, obCluster: '' }, true), /集群名/)
assert.match(validateConnectionProfile({ ...base, type: 'ob-mysql' }, true), /业务数据库/)
assert.match(validateConnectionProfile({ ...base, obTenant: 'a b' }, true), /租户和集群/)
assert.match(validateConnectionProfile({ ...base, user: 'dbadmin@biz#prod', obTenant: 'biz' }, true), /不要重复填写/)

const normalized = normalizeConnectionProfile({ ...base, ssl: true, sslVerifyServer: true, sslCa: 'C:/ca.pem' })
assert.equal(normalized.ssl, true)
assert.equal(normalized.sslVerifyServer, true)
assert.equal(normalized.sslCa, 'C:/ca.pem')
assert.equal(normalized.serviceName, undefined)

const mysqlProfile = normalizeConnectionProfile({
  ...base,
  type: 'mysql',
  database: 'app',
  ssl: true,
  sslVerifyServer: true,
  sslCa: 'C:/ca.pem'
})
assert.equal(mysqlProfile.ssl, true)
assert.equal(mysqlProfile.obTenant, undefined)
assert.equal(mysqlProfile.serviceName, undefined)

const oracleProfile = normalizeConnectionProfile({
  ...base,
  type: 'oracle',
  serviceName: 'orcl',
  ssl: true,
  sslVerifyServer: true,
  sslCa: 'C:/ca.pem'
})
assert.equal(oracleProfile.serviceName, 'orcl')
assert.equal(oracleProfile.ssl, undefined)
assert.equal(oracleProfile.obTenant, undefined)

console.log('connection profile 单测：10 组断言全部通过')
