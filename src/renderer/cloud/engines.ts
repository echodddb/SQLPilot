/**
 * 数据库云平台的「厂商清单」——选择页、进入动画、占位控制台共用这一份。
 *
 * 只有 ocp / oracle 接了真实数据链路；其余引擎目前只做「体系预览」：
 * 进得去、看得懂架构，功能页先占位。
 */

export type EngineId = 'ocp' | 'oracle' | 'mysql' | 'mssql' | 'pg' | 'gauss' | 'dm' | 'kes' | 'tidb'

/** 已经接了真实接口的引擎 */
export const READY_ENGINES: EngineId[] = ['ocp', 'oracle']

export interface EngineMeta {
  id: EngineId
  /** 选择页环形节点上的三字母缩写 */
  code: string
  name: string
  /** 官方品牌色：只用来做色相，最终颜色会跟主题混一次 */
  brand: string
  /** 默认端口：启动画面里挂在名字下面 */
  port: string
  /** 一句话定位 */
  tagline: string
  /** 部署形态 / 关键词 */
  tags: string[]
  /** 架构要点：占位页里给 DBA 看的三四句话 */
  arch: string[]
  /** 计划中的功能模块（占位页里的灰清单） */
  modules: string[]
}

/** 顺序即环形顺序（从 12 点开始顺时针）。启动画面与选择页共用这一份，别再各自排 */
export const ENGINES: EngineMeta[] = [
  {
    id: 'oracle',
    code: 'ORA',
    name: 'Oracle',
    brand: '#e8503a',
    port: '1521',
    tagline: '实例 + 数据库 · SGA 与后台进程 · 多进程架构',
    tags: ['单机 / RAC', 'SGA', '多进程'],
    arch: [
      '用户进程连到 Server Process，一条会话一个服务进程，解析与执行都在它里面',
      'SGA 是共享内存：Buffer Cache 缓存数据块、Shared Pool 缓存 SQL 与执行计划',
      '变更先写 redo log buffer，LGWR 落在线日志，DBWn 异步刷脏块',
      '实例与数据库分离：实例是内存 + 进程，数据库是数据文件 + 控制文件 + 日志'
    ],
    modules: ['实例与数据库', '表空间与数据文件', '会话与锁', 'TopSQL / 执行计划', 'RAC 与 Data Guard', '备份与恢复', '等待事件']
  },
  {
    id: 'ocp',
    code: 'OBS',
    name: 'OceanBase',
    brand: '#2f7ec4',
    port: '2881',
    tagline: '原生分布式 · 三副本 Paxos · 单机可退化为集中式',
    tags: ['分布式', 'Paxos 三副本', 'MySQL 兼容'],
    arch: [
      'OBProxy 只做路由：解析 SQL、定位数据所在 Zone，本身无状态可水平扩',
      '每个 Zone 一套 OBServer，三副本多数派同步，单机也是一套完整数据库',
      '日志流是副本同步的最小单位，Paxos 选主在流内完成',
      '写入先落 MemTable，增量合并成 SSTable，LSM-Tree 不做随机写'
    ],
    modules: ['集群与 Zone 拓扑', '租户与资源池', 'OBProxy 集群', '主机与 Agent', '资源监控', 'SQL 诊断', '备份恢复', '巡检']
  },
  {
    id: 'mysql',
    code: 'MYS',
    name: 'MySQL',
    brand: '#3fa9d6',
    port: '3306',
    tagline: 'Server 层 + 可插拔存储引擎 · InnoDB 事务与复制',
    tags: ['单机 / 主从', 'InnoDB', '可插拔引擎'],
    arch: [
      'Server 层只管连接、解析、优化、执行；真正存取数据的是存储引擎',
      '两层之间靠 Handler API 对接，换引擎（InnoDB / MyRocks）只换下半层',
      'Buffer Pool 缓存数据页与索引页，命中率是性能第一指标',
      'redo 保证崩溃恢复、undo 支撑 MVCC，binlog 负责复制与按时间点恢复'
    ],
    modules: ['实例总览', '会话与连接', 'InnoDB（Buffer Pool / redo / undo）', '主从复制与延迟', '慢 SQL 与执行计划', '参数与变量', '备份与闪回']
  },
  {
    id: 'mssql',
    code: 'MSS',
    name: 'SQL Server',
    brand: '#cc2927',
    port: '1433',
    tagline: 'TDS 协议 · 关系引擎与存储引擎两层',
    tags: ['单机 / AlwaysOn', 'TDS', '两层引擎'],
    arch: [
      '客户端走 TDS 协议，协议层（SNI）负责端点、加密与连接复用',
      '关系引擎做解析、代数化、优化、执行；执行计划进 Plan Cache 复用',
      '存储引擎管访问方法、页与事务，Buffer Pool 缓存 8KB 数据页',
      '数据文件 MDF/NDF 与事务日志 LDF 分离；AlwaysOn 做库级高可用'
    ],
    modules: ['实例与数据库', '会话与阻塞', '执行计划缓存', 'AlwaysOn 可用性组', '等待统计', '备份与还原', '索引与碎片']
  },
  {
    id: 'pg',
    code: 'PGS',
    name: 'PostgreSQL',
    brand: '#6aa9e0',
    port: '5432',
    tagline: '多进程模型 · MVCC · WAL 先行',
    tags: ['单机 / 流复制', '多进程', 'MVCC'],
    arch: [
      'Postmaster 只监听，来一条连接就 fork 一个 Backend 进程，没有线程池',
      '共享内存放 Shared Buffers、WAL Buffer 与锁表，所有进程共享',
      'MVCC 靠元组上的 xmin/xmax 判断可见性，死元组靠 VACUUM 回收',
      'WAL 先写日志再落盘；归档 + 流复制撑起 PITR 与备库'
    ],
    modules: ['实例总览', '连接与后端进程', '表与索引膨胀', 'VACUUM / autovacuum', '流复制与备库延迟', 'WAL 与归档', '慢查询与执行计划']
  },
  {
    id: 'gauss',
    code: 'GDB',
    name: 'GaussDB',
    brand: '#e4002b',
    port: '8000',
    tagline: '分布式 CN / DN / GTM · 分片 + 多副本',
    tags: ['分布式', 'CN/DN/GTM', '多副本'],
    arch: [
      'CN 协调节点接 SQL、生成分布式执行计划，再把子计划下发到 DN',
      'DN 数据节点按分片存数据，每个分片一主多备，日志同步保证不丢',
      'GTM 提供全局事务号与快照，保证跨节点事务的一致性',
      '扩容以分片为单位搬迁，CN 无状态可随时加'
    ],
    modules: ['集群总览', 'CN / DN / GTM 拓扑', '分片与副本', '分布式执行计划', '事务与锁', '节点日志与告警']
  },
  {
    id: 'dm',
    code: 'DM',
    name: 'DM · 达梦',
    brand: '#c98f4a',
    port: '5236',
    tagline: '单进程多线程 · 内存池 · 数据守护',
    tags: ['单机 / 数据守护', '单进程多线程', '国产'],
    arch: [
      'DM 服务器是单进程多线程，一个实例一套内存池，没有多进程开销',
      '内存池分数据缓冲区、日志缓冲区、字典缓存与 SQL 缓存',
      '表空间挂在数据文件上，SYSTEM 与 ROLL 必须存在，REDO 循环写',
      '数据守护（主备）实时同步 redo，支持自动切换与读写分离'
    ],
    modules: ['实例与内存池', '表空间与数据文件', '会话与锁', '数据守护（主备）', '备份与还原', '作业与告警']
  },
  {
    id: 'kes',
    code: 'KES',
    name: 'KingbaseES',
    brand: '#0072bc',
    port: '54321',
    tagline: 'PG 内核 + 国产高可用形态（主备 / RWC / RAC）',
    tags: ['PG 内核', '主备 / RWC / RAC', '国产'],
    arch: [
      '内核同源 PostgreSQL：Postmaster 派生后端进程，一连接一进程',
      '共享内存放数据缓冲与 WAL 缓冲，检查点决定恢复起点',
      '集群形态三选一：流复制主备、KES RWC 读写分离、KES RAC 共享存储',
      'WAL 是复制与 PITR 的基础，归档策略决定能恢复到哪一刻'
    ],
    modules: ['实例总览', '会话与进程', '表空间与膨胀', '流复制主备', 'RWC 读写分离', 'RAC 集群', '备份与归档']
  },
  {
    id: 'tidb',
    code: 'TIDB',
    name: 'TiDB',
    brand: '#dc150b',
    port: '4000',
    tagline: '计算存储分离 · Raft 三副本 · HTAP',
    tags: ['分布式', 'HTAP', 'Raft'],
    arch: [
      'TiDB Server 完全无状态，只做 SQL 解析与分布式执行，加机器就扩容',
      'PD 是集群大脑：分配 TSO、调度 Region、维持副本分布',
      'TiKV 按 Region 切片，每片 Raft 三副本，多数派写入即成功',
      'TiFlash 以 Raft Learner 身份同步，列存跑分析，和行存互不阻塞'
    ],
    modules: ['集群总览', 'TiDB 节点与连接', 'PD 与 Region 调度', 'TiKV 热点与存储', 'TiFlash 列存', '慢查询与执行计划', '备份（BR）']
  }

]

export const engineOf = (id: EngineId): EngineMeta => ENGINES.find((e) => e.id === id) || ENGINES[0]

export const isReady = (id: EngineId): boolean => READY_ENGINES.includes(id)

/** 只有这两家接了真实数据链路，其余是架构预览 */
export const isRealVendor = (id: EngineId): id is 'ocp' | 'oracle' => id === 'ocp' || id === 'oracle'
