/**
 * 采集来源目录汇总：所有模块登记的条目合并成一张表，交给全局悬浮卡组件按 data-src 查。
 * 新增模块只需在本目录加一个 <模块>.ts 并在这里合并，页面里给元素挂 data-src="key" 即可。
 */
import { OV_SOURCES } from './overview'
import { CL_SOURCES } from './clusters'
import { TN_SOURCES } from './tenants'
import { HT_SOURCES } from './hosts'
import { AL_SOURCES, TK_SOURCES } from './alarms'
import { MO_SOURCES } from './monitor'
import { SD_SOURCES } from './sqldiag'
import { PF_SOURCES } from './platform'
import { OR_SOURCES } from './oracle'
import { type SourceInfo } from './types'

export const ALL_SOURCES: Record<string, SourceInfo> = {
  ...OV_SOURCES,
  ...CL_SOURCES,
  ...TN_SOURCES,
  ...HT_SOURCES,
  ...AL_SOURCES,
  ...TK_SOURCES,
  ...MO_SOURCES,
  ...SD_SOURCES,
  ...PF_SOURCES,
  ...OR_SOURCES
}

export { OV_SOURCES, OR_SOURCES }
export type { SourceInfo, SourceOrigin } from './types'
