/**
 * 云平台进入动画的架构模型（720×420 设计稿坐标系）。
 *
 * 每个引擎一套：模块 = 架构里的真实组件，虚线框 = 逻辑边界（Zone / SGA / 引擎层 …），
 * 连线 = 数据或控制流向。形状表达类型：box 存储/代理、hex 进程/节点、cyl 文件/日志。
 *
 * 坐标约定：六行 cy = 36 / 92 / 168 / 250 / 322 / 390；左右边界 60…660。
 */
import type { EngineId } from './engines'

export type Shape = 'box' | 'hex' | 'cyl'
export type Tone = 'core' | 'compute' | 'store' | 'net' | 'mem'

export interface IntroMod {
  k: string
  s?: string
  desc: string
  cx: number
  cy: number
  w: number
  h: number
  shape: Shape
  tone: Tone
  /** 入场起点相对目标的偏移 */
  from: [number, number]
}

export interface IntroFrame {
  label: string
  x: number
  y: number
  w: number
  h: number
}

export interface IntroModel {
  title: string
  subtitle: string
  boot: [string, string, string]
  mods: IntroMod[]
  frames: IntroFrame[]
  wires: Array<[number, number, boolean?]>
  /** 需要覆盖默认语义色的地方（比如 Oracle 用黄色表示日志文件） */
  tones?: Record<string, string>
}

/* ---------------- OceanBase ---------------- */
const OCP: IntroModel = {
  title: 'OCEANBASE',
  subtitle: '原生分布式 · 三副本 Paxos · 单机可退化为集中式',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立副本链路', 'READY · 架构装配完成'],
  mods: [
    { k: 'Client', s: '应用侧', desc: '业务应用通过标准 MySQL 协议接入，无需改驱动、无需改 SQL。', cx: 360, cy: 40, w: 132, h: 44, shape: 'box', tone: 'net', from: [0, -220] },
    { k: 'OBProxy', s: '代理路由', desc: '反向代理：解析 SQL、定位数据所在 Zone，把请求精确转发到指定 OBServer；本身无状态，可水平扩展。', cx: 360, cy: 106, w: 148, h: 52, shape: 'hex', tone: 'net', from: [0, -180] },
    { k: 'OBServer', s: 'Zone 1', desc: '同一份数据的第 1 个副本，内含 SQL 引擎、事务引擎与存储引擎，单机就是一套完整数据库。', cx: 150, cy: 216, w: 132, h: 50, shape: 'hex', tone: 'compute', from: [-240, -50] },
    { k: 'OBServer', s: 'Zone 2', desc: '第 2 个副本：与另外两个 Zone 通过 Paxos 协议多数派同步。', cx: 360, cy: 216, w: 132, h: 50, shape: 'hex', tone: 'compute', from: [0, 150] },
    { k: 'OBServer', s: 'Zone 3', desc: '第 3 个副本：三副本中任意一个故障，多数派仍在，服务不中断。', cx: 570, cy: 216, w: 132, h: 50, shape: 'hex', tone: 'compute', from: [240, -50] },
    { k: 'Log Stream', s: '日志流', desc: '副本同步的基本单位：日志流内用 Paxos 选主，主副本承接写入，其余副本落盘重放。', cx: 212, cy: 306, w: 146, h: 46, shape: 'box', tone: 'store', from: [-200, 180] },
    { k: 'RootService', s: '总控服务', desc: '集群的大脑：负责副本调度、负载均衡、故障切换与 DDL。', cx: 508, cy: 306, w: 146, h: 48, shape: 'hex', tone: 'core', from: [200, 180] },
    { k: 'SSTable', s: 'MemTable / 存储引擎', desc: '写入先进内存 MemTable，增量合并转成磁盘 SSTable；LSM-Tree 结构，写入不随机。', cx: 360, cy: 378, w: 158, h: 58, shape: 'cyl', tone: 'store', from: [0, 240] }
  ],
  frames: [
    { label: 'Zone 1', x: 150, y: 216, w: 176, h: 84 },
    { label: 'Zone 2', x: 360, y: 216, w: 176, h: 84 },
    { label: 'Zone 3', x: 570, y: 216, w: 176, h: 84 }
  ],
  wires: [
    [0, 1],
    [1, 2], [1, 3], [1, 4],
    [2, 5], [3, 5], [4, 5],
    [5, 7],
    /* RootService 是集群总控：指到 Zone 层，不指存储 */
    [6, 3, true],
    [2, 3, true], [3, 4, true]
  ]
}

/* ---------------- Oracle ---------------- */
const ORA: IntroModel = {
  title: 'ORACLE DATABASE',
  subtitle: '实例 + 数据库 · SGA 与后台进程 · 多进程架构',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立内存通路', 'READY · 架构装配完成'],
  tones: { '--tone-store': 'var(--yellow)' },
  mods: [
    { k: '用户进程', s: 'Client', desc: '应用发起的连接会话，经监听器连到实例。', cx: 360, cy: 40, w: 132, h: 44, shape: 'box', tone: 'net', from: [0, -220] },
    { k: 'Server Process', s: '服务进程', desc: '每个会话配一个：解析 SQL、生成执行计划、在 PGA 里做排序与哈希。', cx: 360, cy: 104, w: 156, h: 52, shape: 'hex', tone: 'compute', from: [0, -180] },
    { k: 'Buffer Cache', s: '数据块缓存', desc: '读命中直接返回；未命中的块由 DBWn 从数据文件读入缓冲区。', cx: 150, cy: 226, w: 150, h: 50, shape: 'box', tone: 'mem', from: [-240, -50] },
    { k: 'Shared Pool', s: '共享池', desc: '库缓存存 SQL 与执行计划、数据字典缓存存元数据；硬解析就是这里没命中。', cx: 360, cy: 226, w: 150, h: 50, shape: 'box', tone: 'mem', from: [0, 140] },
    { k: 'Redo Log Buffer', s: '重做缓冲', desc: '每次变更先记 redo，由 LGWR 按条件刷到在线日志。', cx: 570, cy: 226, w: 158, h: 50, shape: 'box', tone: 'mem', from: [240, -50] },
    { k: '后台进程', s: 'DBWn · LGWR · CKPT', desc: 'DBWn 写脏块、LGWR 写重做日志、CKPT 推进检查点、SMON/PMON 负责恢复与清理。', cx: 360, cy: 320, w: 224, h: 50, shape: 'hex', tone: 'compute', from: [0, 180] },
    { k: 'Data Files', s: '数据文件', desc: '表空间落在数据文件上：块、区、段、表空间逐层组织，与 SGA 里的块一一对应。', cx: 240, cy: 384, w: 152, h: 56, shape: 'cyl', tone: 'store', from: [-200, 240] },
    { k: 'Redo Log', s: 'Online Redo', desc: '在线重做日志：循环写，实例崩溃恢复的依据，生产环境必须多路复用。', cx: 500, cy: 384, w: 152, h: 56, shape: 'cyl', tone: 'store', from: [200, 240] }
  ],
  frames: [{ label: 'SGA · System Global Area', x: 360, y: 226, w: 622, h: 118 }],
  wires: [
    [0, 1],
    [1, 2], [1, 3], [1, 4],
    [2, 5], [3, 5], [4, 5],
    [5, 6], [5, 7]
  ]
}

/* ---------------- MySQL ---------------- */
const MYSQL: IntroModel = {
  title: 'MYSQL',
  subtitle: 'Server 层 + 可插拔存储引擎 · InnoDB 事务与复制',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立引擎通路', 'READY · 架构装配完成'],
  mods: [
    { k: 'Client', s: '应用侧', desc: '标准 MySQL 协议接入，驱动与 SQL 都不用改。', cx: 360, cy: 36, w: 132, h: 40, shape: 'box', tone: 'net', from: [0, -220] },
    { k: '连接层', s: 'Thread Pool · 鉴权', desc: '一条连接一个线程（或线程池复用）；鉴权、SSL、最大连接数都在这一层。', cx: 360, cy: 92, w: 186, h: 46, shape: 'hex', tone: 'net', from: [0, -170] },
    { k: 'Parser', s: '词法 / 语法解析', desc: '把 SQL 文本解析成语法树，只判断写法是否成立，不做优化。', cx: 150, cy: 168, w: 150, h: 42, shape: 'box', tone: 'core', from: [-220, -40] },
    { k: 'Optimizer', s: '基于代价 CBO', desc: '生成候选执行计划并估算代价：选哪个索引、要不要回表、Join 用什么算法。', cx: 360, cy: 168, w: 150, h: 42, shape: 'box', tone: 'core', from: [0, 140] },
    { k: 'Executor', s: '调 Handler API', desc: '按执行计划向存储引擎逐行或批量取数，自己不存数据。', cx: 570, cy: 168, w: 150, h: 42, shape: 'box', tone: 'core', from: [220, -40] },
    { k: 'InnoDB', s: '可插拔存储引擎', desc: '默认引擎：事务、行锁、MVCC、崩溃恢复都在这一层，换引擎只换这一层。', cx: 360, cy: 250, w: 196, h: 48, shape: 'hex', tone: 'compute', from: [0, 150] },
    { k: 'Buffer Pool', s: '数据页 / 索引页', desc: '读写都先经过它，命中就不落盘；命中率是 MySQL 性能的第一指标。', cx: 150, cy: 322, w: 158, h: 44, shape: 'box', tone: 'mem', from: [-200, 120] },
    { k: 'Redo / Undo', s: '日志缓冲', desc: 'redo 保证已提交事务不丢（WAL），undo 支撑回滚与一致性读快照。', cx: 360, cy: 322, w: 158, h: 44, shape: 'box', tone: 'mem', from: [0, 150] },
    { k: 'Binlog', s: '复制 / 闪回', desc: 'Server 层日志：记录逻辑变更，主从复制与按时间点恢复都靠它。', cx: 570, cy: 322, w: 158, h: 44, shape: 'box', tone: 'store', from: [200, 120] },
    { k: '数据文件', s: '.ibd · 表空间', desc: '表与索引落在 .ibd 里：页 → 区 → 段 → 表空间逐层组织。', cx: 250, cy: 390, w: 158, h: 48, shape: 'cyl', tone: 'store', from: [-120, 220] },
    { k: 'Redo Log', s: '循环写', desc: '固定大小循环写，写满推进检查点；崩溃重启按它前滚恢复。', cx: 470, cy: 390, w: 158, h: 48, shape: 'cyl', tone: 'store', from: [120, 220] }
  ],
  frames: [{ label: 'Server 层 · Parser → Optimizer → Executor', x: 360, y: 168, w: 614, h: 86 }],
  wires: [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5],
    [5, 6], [6, 9],
    [5, 7], [7, 10],
    [4, 8, true]
  ]
}

/* ---------------- SQL Server ---------------- */
const MSSQL: IntroModel = {
  title: 'SQL SERVER',
  subtitle: 'TDS 协议 · 关系引擎与存储引擎两层',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立 TDS 通路', 'READY · 架构装配完成'],
  mods: [
    { k: 'Client', s: '应用侧', desc: '客户端走 TDS 协议，驱动、连接串都不用改。', cx: 360, cy: 36, w: 132, h: 40, shape: 'box', tone: 'net', from: [0, -220] },
    { k: '协议层', s: 'SNI · TDS 端点', desc: '网络接口层：监听端点、加密、连接复用，把 TDS 包交给关系引擎。', cx: 300, cy: 92, w: 186, h: 46, shape: 'hex', tone: 'net', from: [0, -170] },
    { k: 'Parser', s: '语法解析', desc: '把 T-SQL 解析成语法树，交给优化器代数化。', cx: 150, cy: 168, w: 148, h: 42, shape: 'box', tone: 'core', from: [-220, -40] },
    { k: 'Optimizer', s: '代价优化', desc: '按统计信息估算代价生成执行计划，计划会进 Plan Cache 复用。', cx: 360, cy: 168, w: 148, h: 42, shape: 'box', tone: 'core', from: [0, 140] },
    { k: 'Query Executor', s: '查询执行', desc: '按计划驱动存储引擎取页、做 Join 与聚合。', cx: 570, cy: 168, w: 148, h: 42, shape: 'box', tone: 'core', from: [220, -40] },
    { k: 'Storage Engine', s: '访问方法 · 事务 · 页管理', desc: '真正碰数据的一层：定位页、加锁、管事务日志。', cx: 360, cy: 250, w: 214, h: 48, shape: 'hex', tone: 'compute', from: [0, 150] },
    { k: 'Buffer Pool', s: '8KB 数据页', desc: '数据页的缓存；内存不足时按 LRU 淘汰，Page Life Expectancy 是关键指标。', cx: 185, cy: 322, w: 168, h: 44, shape: 'box', tone: 'mem', from: [-200, 120] },
    { k: 'Log Cache', s: '事务日志缓冲', desc: '日志先写这块再刷 LDF，检查点与恢复都依赖它。', cx: 400, cy: 322, w: 168, h: 44, shape: 'box', tone: 'mem', from: [0, 150] },
    { k: 'MDF / NDF', s: '数据文件', desc: '主数据文件与次要数据文件；文件组决定备份与恢复的粒度。', cx: 230, cy: 390, w: 160, h: 48, shape: 'cyl', tone: 'store', from: [-120, 220] },
    { k: 'LDF', s: '事务日志文件', desc: '先写日志再写数据：恢复模型（完整/大容量/简单）决定日志怎么截断。', cx: 450, cy: 390, w: 160, h: 48, shape: 'cyl', tone: 'store', from: [120, 220] },
    { k: 'AlwaysOn', s: '可用性组', desc: '库级高可用：一主多副本，可配同步提交（RPO=0）或异步提交 + 只读副本。', cx: 596, cy: 92, w: 148, h: 46, shape: 'box', tone: 'net', from: [220, -60] }
  ],
  frames: [{ label: 'Relational Engine · 关系引擎', x: 360, y: 168, w: 614, h: 86 }],
  wires: [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5],
    [5, 6], [6, 8],
    [5, 7], [7, 9],
    [1, 10, true]
  ]
}

/* ---------------- PostgreSQL ---------------- */
const PG: IntroModel = {
  title: 'POSTGRESQL',
  subtitle: '多进程模型 · MVCC · WAL 先行',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立共享内存通路', 'READY · 架构装配完成'],
  mods: [
    { k: 'Client', s: '应用侧', desc: '标准 PG 协议（libpq）接入。', cx: 360, cy: 36, w: 132, h: 40, shape: 'box', tone: 'net', from: [0, -220] },
    { k: 'Postmaster', s: '主进程 · 监听', desc: '只负责监听与派生：每条连接 fork 一个后端进程，主进程本身不干业务。', cx: 360, cy: 92, w: 196, h: 46, shape: 'hex', tone: 'core', from: [0, -170] },
    { k: 'Backend 1', s: '后端进程', desc: '一个连接一个进程：解析、执行、返回结果；进程间靠共享内存通信。', cx: 150, cy: 160, w: 150, h: 42, shape: 'box', tone: 'compute', from: [-220, -40] },
    { k: 'Backend 2', s: '后端进程', desc: '连接数上去就是进程数上去，内存与上下文切换开销比线程模型大。', cx: 360, cy: 160, w: 150, h: 42, shape: 'box', tone: 'compute', from: [0, 140] },
    { k: 'Backend N', s: '后端进程', desc: '连接池（pgbouncer 之类）就是用来压这个进程数的。', cx: 570, cy: 160, w: 150, h: 42, shape: 'box', tone: 'compute', from: [220, -40] },
    { k: 'Shared Buffers', s: '共享缓冲', desc: '8KB 页的共享缓存：命中直接返回，未命中读文件并放进来。', cx: 150, cy: 256, w: 156, h: 42, shape: 'box', tone: 'mem', from: [-200, 110] },
    { k: 'WAL Buffer', s: 'WAL 缓冲', desc: '先写 WAL 再改数据页；提交时 WAL 必须落盘，这是持久化承诺。', cx: 360, cy: 256, w: 156, h: 42, shape: 'box', tone: 'mem', from: [0, 140] },
    { k: '锁表 / CLOG', s: '锁与事务状态', desc: '锁信息与事务提交状态也放共享内存，MVCC 判断可见性要查这里。', cx: 570, cy: 256, w: 156, h: 42, shape: 'box', tone: 'mem', from: [200, 110] },
    { k: '后台进程', s: 'checkpointer · walwriter · autovacuum', desc: '检查点刷脏、WAL 落盘、VACUUM 回收死元组，都是独立后台进程。', cx: 360, cy: 322, w: 300, h: 46, shape: 'hex', tone: 'compute', from: [0, 150] },
    { k: '数据文件', s: '表 / 索引', desc: '堆表 + 索引各自成文件；膨胀与死元组是 PG 特有的运维重点。', cx: 230, cy: 390, w: 156, h: 48, shape: 'cyl', tone: 'store', from: [-120, 220] },
    { k: 'WAL 段', s: 'pg_wal', desc: '16MB 一段循环写；归档后可做 PITR，也可被备库实时回放。', cx: 450, cy: 390, w: 156, h: 48, shape: 'cyl', tone: 'store', from: [120, 220] }
  ],
  frames: [
    { label: 'Backend Process · 一连接一进程', x: 360, y: 160, w: 614, h: 70 },
    { label: 'Shared Memory · 共享内存', x: 360, y: 256, w: 614, h: 70 }
  ],
  wires: [
    [0, 1], [1, 2], [1, 3], [1, 4],
    [2, 5], [4, 6], [2, 7, true],
    [8, 5, true],
    [5, 9], [6, 10]
  ]
}

/* ---------------- GaussDB（分布式） ---------------- */
const GAUSS: IntroModel = {
  title: 'GAUSSDB',
  subtitle: '分布式 CN / DN / GTM · 分片 + 多副本',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立分片通路', 'READY · 架构装配完成'],
  mods: [
    { k: 'Client', s: '应用侧', desc: '应用只连 CN，不感知数据被切成几片、每片几个副本。', cx: 360, cy: 36, w: 132, h: 40, shape: 'box', tone: 'net', from: [0, -220] },
    { k: 'CN', s: '协调节点 1', desc: '接 SQL、生成分布式执行计划、汇总各 DN 的结果；无状态，可随时加。', cx: 200, cy: 108, w: 176, h: 46, shape: 'hex', tone: 'core', from: [-220, -120] },
    { k: 'CN', s: '协调节点 2', desc: '多 CN 前面挂负载均衡，单点故障不影响整体。', cx: 520, cy: 108, w: 176, h: 46, shape: 'hex', tone: 'core', from: [220, -120] },
    { k: 'GTM', s: '全局事务管理', desc: '分配全局事务号与快照，跨 DN 的事务靠它保证一致性。', cx: 360, cy: 176, w: 176, h: 46, shape: 'hex', tone: 'core', from: [0, -60] },
    { k: 'DN 1 · 主', s: '分片 1', desc: '分片 1 的主副本：承接该分片的读写。', cx: 150, cy: 246, w: 156, h: 44, shape: 'box', tone: 'compute', from: [-240, 60] },
    { k: 'DN 1 · 备', s: '同步复制', desc: '备副本实时回放日志，主挂了可以切上来，RPO=0。', cx: 150, cy: 320, w: 156, h: 44, shape: 'box', tone: 'compute', from: [-240, 150] },
    { k: 'DN 2 · 主', s: '分片 2', desc: '分片 2 的主副本；扩容以分片为单位搬迁。', cx: 360, cy: 246, w: 156, h: 44, shape: 'box', tone: 'compute', from: [0, 60] },
    { k: 'DN 2 · 备', s: '同步复制', desc: '多数派确认后才返回提交成功。', cx: 360, cy: 320, w: 156, h: 44, shape: 'box', tone: 'compute', from: [0, 150] },
    { k: 'DN 3 · 主', s: '分片 3', desc: '分片 3 的主副本。', cx: 570, cy: 246, w: 156, h: 44, shape: 'box', tone: 'compute', from: [240, 60] },
    { k: 'DN 3 · 备', s: '同步复制', desc: '备副本承接只读查询，分摊分析型负载。', cx: 570, cy: 320, w: 156, h: 44, shape: 'box', tone: 'compute', from: [240, 150] },
    { k: '分片数据文件', s: '行存 / 列存', desc: '每个 DN 自己一套数据文件；行存表、列存表可以按表选。', cx: 250, cy: 392, w: 168, h: 44, shape: 'cyl', tone: 'store', from: [-120, 220] },
    { k: 'WAL / Redo', s: '节点日志', desc: '每个 DN 各自写自己的日志，主备之间靠它同步与恢复。', cx: 480, cy: 392, w: 168, h: 44, shape: 'cyl', tone: 'store', from: [120, 220] }
  ],
  frames: [
    { label: '分片 1 · 主备', x: 150, y: 283, w: 186, h: 132 },
    { label: '分片 2 · 主备', x: 360, y: 283, w: 186, h: 132 },
    { label: '分片 3 · 主备', x: 570, y: 283, w: 186, h: 132 }
  ],
  wires: [
    [0, 1], [0, 2],
    [1, 3, true], [2, 3, true],
    [1, 4], [1, 6], [2, 8],
    [4, 5], [6, 7], [8, 9],
    [6, 10, true], [6, 11, true]
  ]
}

/* ---------------- DM 达梦 ---------------- */
const DM: IntroModel = {
  title: 'DM · 达梦',
  subtitle: '单进程多线程 · 内存池 · 数据守护',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立内存池通路', 'READY · 架构装配完成'],
  mods: [
    { k: 'Client', s: '应用侧', desc: '标准 DM 驱动或 ODBC/JDBC 接入。', cx: 360, cy: 36, w: 132, h: 40, shape: 'box', tone: 'net', from: [0, -220] },
    { k: 'DM Server', s: '单进程 · 多线程', desc: '一个实例就是一个进程，会话是线程：没有多进程共享内存的开销。', cx: 330, cy: 96, w: 210, h: 46, shape: 'hex', tone: 'core', from: [0, -170] },
    { k: '数据守护', s: '主备 · 自动切换', desc: '主库把 redo 实时发给备库，支持自动接管与读写分离部署。', cx: 596, cy: 96, w: 150, h: 46, shape: 'box', tone: 'net', from: [200, -80] },
    { k: '数据缓冲区', s: 'Buffer Pool', desc: '数据页缓存，占内存池的大头；命中率直接决定磁盘 IO。', cx: 150, cy: 176, w: 156, h: 44, shape: 'box', tone: 'mem', from: [-200, -40] },
    { k: '日志缓冲区', s: 'Redo Buffer', desc: 'redo 先写这里，再由线程刷到联机日志文件。', cx: 360, cy: 176, w: 156, h: 44, shape: 'box', tone: 'mem', from: [0, -120] },
    { k: '字典 / SQL 缓存', s: 'Dictionary Cache', desc: '数据字典与执行计划缓存，硬解析就是这里没命中。', cx: 570, cy: 176, w: 156, h: 44, shape: 'box', tone: 'mem', from: [200, -40] },
    { k: '存储层', s: '表空间 → 段 → 簇 → 页', desc: 'DM 自己管存储：所有对象都落在表空间里，再由表空间映射到数据文件。', cx: 360, cy: 258, w: 240, h: 48, shape: 'hex', tone: 'compute', from: [0, 140] },
    { k: 'SYSTEM', s: '系统表空间', desc: '数据字典与系统对象，必须存在，容量要盯着。', cx: 170, cy: 330, w: 140, h: 42, shape: 'box', tone: 'store', from: [-200, 150] },
    { k: 'ROLL', s: '回滚表空间', desc: '回滚段放这里：支撑事务回滚与一致性读。', cx: 360, cy: 330, w: 140, h: 42, shape: 'box', tone: 'store', from: [0, 160] },
    { k: 'MAIN', s: '用户表空间', desc: '业务表与索引默认落这里，可按业务拆多个表空间。', cx: 550, cy: 330, w: 140, h: 42, shape: 'box', tone: 'store', from: [200, 150] },
    { k: '数据文件', s: '.dbf', desc: '表空间由若干数据文件组成，可以扩文件也可以加文件。', cx: 250, cy: 392, w: 156, h: 44, shape: 'cyl', tone: 'store', from: [-120, 220] },
    { k: '联机日志', s: 'Redo Log', desc: '循环写，至少两组：实例崩溃恢复的依据。', cx: 470, cy: 392, w: 156, h: 44, shape: 'cyl', tone: 'store', from: [120, 220] }
  ],
  frames: [{ label: '内存池 · Memory Pools', x: 360, y: 176, w: 614, h: 82 }],
  wires: [
    [0, 1], [1, 3], [1, 4], [1, 5],
    [3, 6], [4, 6],
    [6, 7], [6, 8], [6, 9],
    [7, 10], [4, 11],
    [1, 2, true]
  ]
}

/* ---------------- KingbaseES ---------------- */
const KES: IntroModel = {
  title: 'KINGBASEES',
  subtitle: 'PG 内核 · 流复制 / RWC / RAC 三种集群形态',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立 WAL 通路', 'READY · 架构装配完成'],
  mods: [
    { k: 'Client', s: '应用侧', desc: '兼容 PG 协议的驱动直接连，KStudio / ksql 也能用。', cx: 360, cy: 36, w: 132, h: 40, shape: 'box', tone: 'net', from: [0, -220] },
    { k: 'Kingbase 服务器', s: 'Postmaster · 多进程', desc: 'PG 同源内核：主进程监听，每条连接一个后端进程。', cx: 360, cy: 92, w: 210, h: 46, shape: 'hex', tone: 'core', from: [0, -170] },
    { k: 'Shared Buffers', s: '共享缓冲', desc: '数据页共享缓存；shared_buffers 是最该先调的参数。', cx: 150, cy: 170, w: 156, h: 42, shape: 'box', tone: 'mem', from: [-200, -40] },
    { k: 'WAL Buffer', s: 'WAL 缓冲', desc: 'WAL 先落盘再改数据页，检查点决定崩溃恢复要回放多少。', cx: 360, cy: 170, w: 156, h: 42, shape: 'box', tone: 'mem', from: [0, -120] },
    { k: '锁 / 字典缓存', s: '共享结构', desc: '锁表与系统目录缓存，所有后端进程共享。', cx: 570, cy: 170, w: 156, h: 42, shape: 'box', tone: 'mem', from: [200, -40] },
    { k: '后台进程', s: 'checkpointer · walwriter · autovacuum', desc: '刷脏、写 WAL、清理死元组，与 PG 一致的后台体系。', cx: 360, cy: 252, w: 300, h: 46, shape: 'hex', tone: 'compute', from: [0, 140] },
    { k: '流复制主备', s: '物理复制', desc: '备库实时回放 WAL，可做只读分担与故障切换。', cx: 160, cy: 322, w: 176, h: 46, shape: 'box', tone: 'net', from: [-220, 150] },
    { k: 'KES RWC', s: '读写分离集群', desc: '一主多备 + 读写分离中间件，写走主、读分摊到备。', cx: 360, cy: 322, w: 176, h: 46, shape: 'box', tone: 'net', from: [0, 160] },
    { k: 'KES RAC', s: '共享存储集群', desc: '多节点共享一份存储，节点故障业务不中断——国产化替代 RAC 的形态。', cx: 560, cy: 322, w: 176, h: 46, shape: 'box', tone: 'net', from: [220, 150] },
    { k: '数据文件', s: '表 / 索引', desc: '表与索引各自成文件，膨胀与 VACUUM 依旧是运维重点。', cx: 250, cy: 396, w: 156, h: 42, shape: 'cyl', tone: 'store', from: [-120, 220] },
    { k: 'WAL 段', s: '归档 / 复制源', desc: '归档打开才能做 PITR，也是主备复制的源头。', cx: 470, cy: 396, w: 156, h: 42, shape: 'cyl', tone: 'store', from: [120, 220] }
  ],
  frames: [
    { label: '共享内存 · Shared Memory', x: 360, y: 170, w: 614, h: 80 },
    { label: '集群形态 · 三选一', x: 360, y: 322, w: 620, h: 76 }
  ],
  wires: [
    [0, 1], [1, 2], [1, 3], [1, 4],
    [1, 5, true],
    [5, 6], [5, 7], [5, 8],
    [6, 10], [2, 9]
  ]
}

/* ---------------- TiDB ---------------- */
const TIDB: IntroModel = {
  title: 'TIDB',
  subtitle: '计算存储分离 · Raft 三副本 · HTAP',
  boot: ['BOOT · 加载架构模型', 'LINK · 建立 Region 通路', 'READY · 架构装配完成'],
  mods: [
    { k: 'Client', s: '应用侧', desc: 'MySQL 协议兼容，业务侧几乎不用改。', cx: 360, cy: 36, w: 132, h: 40, shape: 'box', tone: 'net', from: [0, -220] },
    { k: 'LB / Proxy', s: '负载均衡', desc: '把连接分给多个 TiDB Server；TiDB 挂了换一个继续，无状态。', cx: 140, cy: 96, w: 150, h: 46, shape: 'box', tone: 'net', from: [-220, -120] },
    { k: 'TiDB Server', s: '无状态 SQL 层', desc: '解析、优化、生成分布式执行计划，再把请求下推到 TiKV / TiFlash。', cx: 360, cy: 96, w: 196, h: 46, shape: 'hex', tone: 'compute', from: [0, -170] },
    { k: 'PD', s: 'TSO · 调度', desc: '集群大脑：分配全局时间戳、调度 Region 与副本，PD 挂了写入会停。', cx: 590, cy: 96, w: 150, h: 46, shape: 'hex', tone: 'core', from: [220, -120] },
    { k: 'TiKV 1', s: 'Region 副本', desc: '按 Region 切片存储，每片 Raft 三副本，多数派写入即成功。', cx: 150, cy: 246, w: 156, h: 44, shape: 'box', tone: 'compute', from: [-240, 60] },
    { k: 'TiKV 2', s: 'Region 副本', desc: 'Raft Leader 挂了，同组副本重新选主，秒级切换。', cx: 360, cy: 246, w: 156, h: 44, shape: 'box', tone: 'compute', from: [0, 60] },
    { k: 'TiKV 3', s: 'Region 副本', desc: '副本分布由 PD 调度，保证不落在同一台机器 / 机架上。', cx: 570, cy: 246, w: 156, h: 44, shape: 'box', tone: 'compute', from: [240, 60] },
    { k: 'TiFlash', s: '列存 · Raft Learner', desc: '以 Learner 身份同步数据，列存跑分析不影响行存写入，这就是 HTAP。', cx: 360, cy: 326, w: 220, h: 46, shape: 'box', tone: 'mem', from: [0, 150] },
    { k: 'RocksDB', s: '行存引擎', desc: 'TiKV 底层 LSM-Tree：写先进内存再刷 SST，天然适合写多读少的场景。', cx: 250, cy: 392, w: 158, h: 44, shape: 'cyl', tone: 'store', from: [-120, 220] },
    { k: '列存文件', s: 'DeltaTree', desc: '按列组织 + 按段索引，聚合与扫描只读需要的列。', cx: 470, cy: 392, w: 158, h: 44, shape: 'cyl', tone: 'store', from: [120, 220] }
  ],
  frames: [{ label: 'TiKV · Region · Raft 三副本', x: 360, y: 246, w: 620, h: 84 }],
  wires: [
    [0, 1], [1, 2], [2, 3, true],
    [2, 4], [2, 5], [2, 6],
    [4, 8], [5, 7, true], [7, 9],
    [4, 5, true], [5, 6, true]
  ]
}

export const INTRO_MODELS: Record<EngineId, IntroModel> = {
  ocp: OCP,
  oracle: ORA,
  mysql: MYSQL,
  mssql: MSSQL,
  pg: PG,
  gauss: GAUSS,
  dm: DM,
  kes: KES,
  tidb: TIDB
}
