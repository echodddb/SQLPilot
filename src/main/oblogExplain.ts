/**
 * OB 日志「人话解释」知识库。
 *
 * 日志本身是给内核开发者看的：`[时间] 级别 [模块] 函数 (文件:行) [线程ID][线程名][租户][trace]
 * [lt=耗时][errcode=码] 正文` —— 一条 INFO 里 90% 是内部字段，DBA 看不出「这要不要管」。
 * 这里把四类锚点映射成「是什么 / 要不要管 / 怎么办」，按可靠性排序取最严重的一档：
 *
 * 1. errcode —— 语义最稳定，跨版本不变（-4076 永远是 OB_NEED_WAIT），但收录不全
 * 2. 报错文案 —— 错误码记不全时的主力："No space left" 这种文案自解释且跨版本稳定
 * 3. 组件指纹（文件名 > 函数名）—— 判断是不是某类已知故障；行号会漂，文件名不会
 * 4. 模块前缀 —— 兜底，至少能说清是哪个子系统
 *
 * 刻意不用 `文件:行` 做键：OB 小版本升级就会让整张表失效。
 * verdict 三档：normal（正常，可忽略）/ watch（注意）/ bad（有问题，要处理）。
 * 拿不准的宁可标 watch 并写清「需要结合上下文」，也不硬下结论。
 */

export type ObVerdict = 'normal' | 'watch' | 'bad'

export interface ObExplain {
  /** 这是什么（人话） */
  what: string
  verdict: ObVerdict
  /** 怎么办；normal 档为空 */
  advice?: string
  /** 命中的规则名，便于自检与排查（errcode:-4076 / func:dump_dag_status / module:PALF / fallback） */
  rule: string
}

interface KbItem {
  what: string
  verdict: ObVerdict
  advice?: string
}

/** 错误码：OB 的 ret 码，负数。语义跨版本稳定 */
export const ERRCODE_KB: Record<string, KbItem> = {
  '-4002': {
    what: '参数非法：调用方传了不合法的值。若来自 RSInspectTask（根服务巡检），通常是自检 SQL 在异常租户上取到了不存在的对象',
    verdict: 'watch',
    advice: '看是不是集中在某个租户；单条偶发可忽略'
  },
  '-4006': {
    what: '对象还没初始化就被调用了，一般出现在启动期或关闭期',
    verdict: 'normal'
  },
  '-4007': {
    what: '这个功能在当前部署形态下不支持。单副本/单机集群做「连远端 RootService」「多副本同步」这类操作时必然返回',
    verdict: 'normal'
  },
  '-4008': {
    what: '迭代结束（End of iteration）—— 名字吓人，其实是「没有更多行了」的正常终止信号，相当于 EOF',
    verdict: 'normal'
  },
  '-4009': {
    what: 'IO 错误：socket 读写失败。出现在 RPC.OBMYSQL 的 async_write_data，通常是客户端已经超时断开，OB 写回包时才发现',
    verdict: 'watch',
    advice: '次数多就查客户端连接池：是不是探活太频繁、超时设太短、或网络抖动'
  },
  '-4013': {
    what: '操作超时',
    verdict: 'watch',
    advice: '结合同一时刻的 -4389（耗时过长）一起看，多半是 IO/CPU 打满'
  },
  '-4015': {
    what: '连接被客户端主动关闭（close sql sock by user req）',
    verdict: 'normal'
  },
  '-4018': {
    what: '条目不存在：去系统表里查某个对象没查到。内部定时任务在租户/日志流刚建好或刚删掉时会碰到',
    verdict: 'normal'
  },
  '-4023': {
    what: '任务没加上，需要重试。内部任务队列满或状态机不允许时出现，OB 会自己重试',
    verdict: 'normal'
  },
  '-4024': {
    what: '当前节点不是 Leader，操作被拒。切主/单副本期间正常',
    verdict: 'normal'
  },
  '-4030': {
    what: '角色不允许执行该操作（主备角色不匹配）',
    verdict: 'watch',
    advice: '检查主备关系是否正常'
  },
  '-4043': {
    what: '账号认证失败（Access denied for user）—— 密码错或用户不存在',
    verdict: 'bad',
    advice: '查是哪个应用在连；通常是配置里留了旧密码，或账号没建'
  },
  '-4076': {
    what: '需要等待（OB_NEED_WAIT）：依赖的东西还没就绪，OB 自己会重试',
    verdict: 'watch',
    advice: '看来源函数：来自 standby 时间戳服务/日志同步说明主库不可达；短时间出现属正常'
  },
  '-4077': {
    what: '功能未实现（not implement）：用到了内核还没支持的能力',
    verdict: 'normal'
  },
  '-4138': {
    what: 'schema 版本不匹配：DDL 刚做完，缓存还没刷新',
    verdict: 'normal'
  },
  '-4147': {
    what: '对象已存在（重复创建）',
    verdict: 'normal'
  },
  '-4152': {
    what: '取到空值：内部 SQL 查询结果为空又按非空处理',
    verdict: 'normal'
  },
  '-4216': {
    what: 'curl 请求失败：OB 主动去访问一个外部 HTTP 地址（OCP / OBProxy / 外部 RootService）没连上',
    verdict: 'watch',
    advice: 'curl_error_code=7 是连接被拒、28 是超时。确认配置里那个外部地址还要不要，不要就清掉'
  },
  '-4389': {
    what: '某个操作耗时超过阈值（time guard 打点），是性能提示不是错误',
    verdict: 'watch',
    advice: '少量正常；成规模出现配合 IO/CPU 指标看'
  },
  '-4747': {
    what: '拿不到仲裁服务（arbitration service）信息。单机或未部署仲裁服务的集群会一直报',
    verdict: 'normal'
  },
  '-5019': {
    what: '表不存在',
    verdict: 'watch',
    advice: '应用侧 SQL 引用了不存在的表；集中在某个租户就查那个租户'
  },
  '-5024': {
    what: '列已存在（重复加列）',
    verdict: 'normal'
  },
  '-5055': {
    what: '函数不存在（FUNCTION does not exist）：SQL 里调了没定义的内置函数或 UDF',
    verdict: 'bad',
    advice: '找出发这条 SQL 的应用；MySQL 函数名拼错或用了 OB 不支持的同名函数'
  },
  '-5134': {
    what: '没有选中数据库就执行了不带库名的 SQL',
    verdict: 'watch',
    advice: '应用连接串没指定默认库'
  },
  '-5154': {
    what: '库不存在（Unknown database）',
    verdict: 'watch',
    advice: '应用连了一个不存在的库；多见于租户刚建、库还没建好就起服务'
  },
  '-5217': {
    what: '列不存在（Unknown column）',
    verdict: 'watch',
    advice: 'SQL 与表结构不一致，多半是版本发布时表结构没同步'
  },
  '-5543': {
    what: '用了未声明的变量',
    verdict: 'normal'
  },
  '-6004': {
    what: '锁冲突，需要重试（OB 内部事务锁，不是行锁）',
    verdict: 'normal'
  },
  '-6005': {
    what: '行锁等待超时',
    verdict: 'bad',
    advice: '有长事务或热点行；查 gv$ob_sql_audit 里耗时最长的写语句'
  },
  '-6006': {
    what: '主键冲突（Duplicate entry）',
    verdict: 'watch',
    advice: '应用侧重复插入；偶发正常，成规模说明业务有并发写同一主键'
  }
}

/**
 * 日志正文关键词 → 解释。
 *
 * 为什么需要这一层：错误码有几百个，靠人肉记全不现实；但报错文案本身是自解释的 ——
 * "No space left on device" 比"某个 -xxxx 错误码"有用得多，而且文案跨版本基本不变。
 * 只在「错误码没收录」时用作二次判断（有错误码的行才可能是异常，所以不会误伤 INFO 刷屏）。
 *
 * 匹配用小写包含，所以键要写得足够具体，别拿 "timeout"/"fail" 这种词进来。
 */
export const TEXT_KB: { match: string; item: KbItem }[] = [
  {
    match: 'no space left',
    item: {
      what: '磁盘空间写满了。OB 遇到这个会直接停写，是最高优先级的故障',
      verdict: 'bad',
      advice: '立刻清日志/扩盘；clog 盘满会让整个集群不可写'
    }
  },
  {
    match: 'disk is almost full',
    item: {
      what: '磁盘快到阈值了（clog 盘 / 数据盘）',
      verdict: 'bad',
      advice: '到 log_disk_utilization_limit_threshold 就会停写，别等到报错才处理'
    }
  },
  {
    match: 'out of memory',
    item: {
      what: '内存不足',
      verdict: 'bad',
      advice: '查租户内存上限（memory_size）与 MemTable 占用；也可能是 SQL 一次拉太多行'
    }
  },
  {
    match: 'cannot allocate memory',
    item: {
      what: '申请内存失败（可能是 OS 层面也不够了）',
      verdict: 'bad',
      advice: '看 free -g 与 /proc/meminfo，确认没被其他进程吃掉'
    }
  },
  {
    match: 'cannot allocate disk',
    item: {
      what: '申请磁盘空间失败',
      verdict: 'bad',
      advice: '检查数据盘剩余空间与 inode 数'
    }
  },
  {
    match: 'checksum',
    item: {
      what: '校验和不一致：读到的东西和记录的指纹对不上，可能是磁盘坏块或写坏了',
      verdict: 'bad',
      advice: '别忽略；先确认是否单块磁盘问题，必要时从副本或备份恢复'
    }
  },
  {
    match: 'corrupt',
    item: {
      what: '数据损坏（文件/块/元数据）',
      verdict: 'bad',
      advice: '立即排查磁盘健康（dmesg 里找 IO error），并评估从备份恢复'
    }
  },
  {
    match: 'deadlock',
    item: {
      what: '死锁：两个事务互相等对方的锁，OB 会主动回滚其中一个',
      verdict: 'bad',
      advice: '按业务上固定顺序加锁可避免；查 gv$ob_sql_audit 里被回滚的语句'
    }
  },
  {
    match: 'lock wait timeout',
    item: {
      what: '等行锁超时：有长事务一直占着这行',
      verdict: 'bad',
      advice: '找出持锁的长事务并提交/回滚；查 gv$ob_trx_lockwait 与 gv$ob_sql_audit'
    }
  },
  {
    match: 'lock conflict',
    item: {
      what: '锁冲突需要重试（OB 内部会自己重试）',
      verdict: 'watch',
      advice: '偶发正常；成规模说明有热点行被并发写'
    }
  },
  {
    match: 'access denied',
    item: {
      what: '账号认证失败：密码错或用户不存在',
      verdict: 'bad',
      advice: '查是哪个应用在连；通常是配置里留了旧密码'
    }
  },
  {
    match: 'permission denied',
    item: {
      what: '权限不足：账号没这个对象的操作权限',
      verdict: 'bad',
      advice: '补 GRANT；注意 OB 的权限要精确到库/表'
    }
  },
  {
    match: 'too many sessions',
    item: {
      what: '会话数超过上限（max_connections / 租户连接数限制）',
      verdict: 'watch',
      advice: '查连接池有没有泄漏；必要时调大 max_connections'
    }
  },
  {
    match: 'too many connections',
    item: {
      what: '连接数超限',
      verdict: 'watch',
      advice: '同 too many sessions：先看连接池，再考虑调参'
    }
  },
  {
    match: 'packet too large',
    item: {
      what: '单个网络包超过上限（一般是超大 SQL 或大字段）',
      verdict: 'watch',
      advice: '调大 max_allowed_packet，或把大 SQL 拆开/改用批量'
    }
  },
  {
    match: 'connection reset',
    item: {
      what: '连接被对端重置（网络中断或中间设备掐断）',
      verdict: 'watch',
      advice: '查客户端到 OB 之间的网络，以及是否有负载均衡空闲超时'
    }
  },
  {
    match: 'broken pipe',
    item: {
      what: '往已关闭的连接写数据',
      verdict: 'watch',
      advice: '通常是客户端先断开；次数多查连接池探活'
    }
  },
  {
    match: 'duplicate entry',
    item: {
      what: '主键/唯一键冲突',
      verdict: 'watch',
      advice: '应用侧重复插入；成规模说明并发写同一主键，考虑改成 upsert'
    }
  },
  {
    match: 'unknown column',
    item: {
      what: 'SQL 里的列在表中不存在',
      verdict: 'watch',
      advice: '表结构与代码不一致，多半是发布时 ALTER 没跟上'
    }
  },
  {
    match: 'unknown database',
    item: {
      what: '连了一个不存在的库',
      verdict: 'watch',
      advice: '应用连接串的库名写错，或库还没建好服务就起来了'
    }
  },
  {
    match: 'table not exist',
    item: {
      what: '表不存在',
      verdict: 'watch',
      advice: '看是哪个租户/库；可能是建表脚本没跑，或连错了库'
    }
  },
  {
    match: 'no database selected',
    item: {
      what: '没指定库就执行了 SQL',
      verdict: 'watch',
      advice: '连接串补上默认库，或 SQL 里写全 库名.表名'
    }
  },
  {
    match: 'schema version',
    item: {
      what: 'schema 版本对不上：DDL 刚做完，缓存还没刷新',
      verdict: 'normal'
    }
  },
  {
    match: 'fail to replay',
    item: {
      what: '日志回放失败。回放是恢复数据一致性的关键路径',
      verdict: 'bad',
      advice: '不要忽略；确认是否需要从备份恢复'
    }
  },
  {
    match: 'no such file',
    item: {
      what: '文件不存在（配置指向的路径没有对应文件）',
      verdict: 'watch',
      advice: '核对配置里的目录是否被清理过，或挂载点没挂上'
    }
  },
  {
    match: 'invalid config',
    item: {
      what: '配置项非法',
      verdict: 'watch',
      advice: '看 ALTER SYSTEM SET 的参数名/值是否拼错，或超出取值范围'
    }
  },
  {
    match: 'cost too much time',
    item: {
      what: '某个步骤耗时超过阈值',
      verdict: 'watch',
      advice: '性能提示不是错误；配合 IO/CPU 指标看是否成规模'
    }
  },
  {
    match: 'queue is full',
    item: {
      what: '队列满了，任务只能丢弃或等待',
      verdict: 'watch',
      advice: '说明上游产生速度超过处理能力；查是否卡在 IO 或锁上'
    }
  },
  {
    match: 'is stopping',
    item: {
      what: '节点/服务正在停止，此时拒绝新请求',
      verdict: 'watch',
      advice: '如果是主动重启属正常；非预期停止要查 OOM 或崩溃日志'
    }
  },
  {
    match: 'tenant not exist',
    item: {
      what: '租户不存在（可能刚被删或还没建好）',
      verdict: 'watch',
      advice: '核对 tenant_id；内部任务通常下一轮自动恢复'
    }
  },
  {
    match: 'out of range',
    item: {
      what: '值超出允许范围（时间、数值、长度等）',
      verdict: 'watch',
      advice: '看是哪个字段越界：时间类型多半是导入脏数据或格式不对，数值类型检查是否溢出'
    }
  },
  {
    match: 'failed to get latest data',
    item: {
      what: '取表级多源数据（MDS）的最新版本失败，通常是元数据还在刷新',
      verdict: 'watch',
      advice: '内部任务会自己重试；持续出现说明该表的元数据一直没就绪'
    }
  }
]

/**
 * 组件指纹 → 解释。键在三个地方做包含匹配，按可靠性排序：
 *   1. 文件名（`ob_standby_timestamp_service.cpp`）—— 最稳，跨版本不变，且唯一
 *   2. 函数名（`dump_dag_status`）—— 能识别到具体动作，但 OB 里很多是 `run1`/`stat` 这类通用词
 *   3. 模块前缀 —— 兜底
 * 顺序敏感：先匹配到的赢，所以更具体的放前面。
 */
export const SITE_KB: { match: string; item: KbItem }[] = [
  {
    match: 'ob_standby_timestamp_service',
    item: {
      what: '备租户（standby）的时间戳服务：定期向主库要时间戳来推进本地读版本。一直失败说明这个备租户没有可用的主库',
      verdict: 'bad',
      advice: '确认这个备租户还要不要：要就修主库地址/网络，不要就 DROP TENANT，否则它会每 100ms 刷一条日志'
    }
  },
  {
    match: 'ob_timer_monitor',
    item: {
      what: '定时器监控：检测到某个定时任务的执行间隔超出预期（任务堆积或线程被占住）',
      verdict: 'watch',
      advice: '看同一时刻有没有慢 SQL / IO 打满；偶发可忽略，持续出现说明后台任务在排队'
    }
  },
  {
    match: 'ob_sql_sock_session',
    item: {
      what: '给客户端连接写回包时发现 socket 已断 —— 客户端先走了',
      verdict: 'watch',
      advice: '配合 -4009 看：次数多说明客户端连接池探活/超时策略有问题'
    }
  },
  {
    match: 'ob_schema_checker',
    item: {
      what: 'SQL 解析前先查库/表/列是否存在。报错说明 SQL 引用的对象在当前租户里找不到',
      verdict: 'watch',
      advice: '配合 -5154/-5217 看是哪个租户，多半是应用连错库或表结构没同步'
    }
  },
  {
    match: 'ob_select_resolver',
    item: {
      what: '解析 SELECT 语句里的列引用。报错说明 SQL 用了表里没有的列',
      verdict: 'watch',
      advice: '表结构与代码不一致；配合 -5217 看是哪个租户，多半是发布时 ALTER 没跟上'
    }
  },
  {
    match: 'ob_web_service_root_addr',
    item: {
      what: 'OB 通过 HTTP 去问外部服务「RootService 在哪儿」。单机集群没有外部 RS 时会失败',
      verdict: 'normal'
    }
  },
  {
    match: 'load_arb_service_info',
    item: {
      what: '加载仲裁服务信息。没部署仲裁服务的集群必然拿不到',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_ls_status_operator',
    item: {
      what: '查日志流（LS）状态表。查不到说明该 LS 还没登记或刚被删',
      verdict: 'normal'
    }
  },
  {
    match: 'dump_dag_status',
    item: {
      what: 'DAG 并行任务调度器在转储自己的状态（有多少任务在排队、跑着、卡住）',
      verdict: 'normal'
    }
  },
  {
    match: 'get_kept_multi_version_start',
    item: {
      what: 'SSTable 垃圾回收线程在扫表，算出哪些旧版本数据可以清掉。合并之后必然要跑',
      verdict: 'normal'
    }
  },
  {
    match: 'execute_write_inner',
    item: {
      what: 'OB 自己发起的内部 SQL 写（写系统表）。内部任务频繁时量大属正常',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_id_service',
    item: {
      what: '分配自增 ID / 号段，内部取号',
      verdict: 'normal'
    }
  },
  {
    match: 'advance_clock',
    item: {
      what: '内存分配器（fifo arena）推进时钟，回收已释放的内存块',
      verdict: 'normal'
    }
  },
  {
    match: 'replace_map',
    item: {
      what: 'KVCache 淘汰旧缓存条目',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_agent_virtual_table',
    item: {
      what: '读取内部虚拟表（agent 相关），供监控/内部查询用',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_tenant_freezer',
    item: {
      what: '租户内存冻结（把可回收的内存交给全局复用）',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_checkpoint_service',
    item: {
      what: '推进检查点，为日志回收腾空间',
      verdict: 'normal'
    }
  },
  // ---- 明确异常类（放前面，先把它们截住）----
  {
    match: 'ob_pl_resolver',
    item: {
      what: '存储过程 / 自定义函数（PL）的解析。报错说明调用方引用了一个不存在的存储过程或函数',
      verdict: 'bad',
      advice: '找发这条 SQL 的应用：函数名拼错，或升级时漏建了存储过程'
    }
  },
  {
    match: 'ob_arbitration',
    item: {
      what: '仲裁服务（为两地三中心提供"第三方裁判"，防脑裂）。单机或未部署仲裁的集群会一直报',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_heartbeat',
    item: {
      what: '节点/租户心跳。失败说明对端没响应，通常是网络或对端卡住',
      verdict: 'watch',
      advice: '心跳失败会引发误切主，次数多了要查网络和节点负载'
    }
  },
  {
    match: 'ob_ls_transfer',
    item: {
      what: '日志流（副本）迁移，均衡或缩容时把副本搬到别的节点',
      verdict: 'watch',
      advice: '迁移中报错会卡住均衡；看是否目标节点空间不足或网络不通'
    }
  },
  {
    match: 'ob_tenant_ddl_service',
    item: {
      what: '租户级 DDL（建租户、改副本数、改资源池）',
      verdict: 'watch',
      advice: 'DDL 失败常因资源不足或副本位置冲突，看 error 里的具体原因'
    }
  },
  // ---- 存储与合并 ----
  {
    match: 'ob_compaction',
    item: {
      what: '合并（compaction）调度与执行：把内存数据和旧 SSTable 归并成新文件',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_memtable',
    item: {
      what: '内存表（MemTable）读写。数据先写这里，冻结后转 SSTable',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_sstable',
    item: {
      what: '静态表（SSTable）读取与元数据',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_tablet_gc',
    item: {
      what: '表级垃圾回收：清理被删除/合并掉的多版本数据',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_ls_service',
    item: {
      what: '日志流（LS）服务：一个 LS 是一组副本的读写单位',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_ls_mgr',
    item: {
      what: '日志流管理器：创建/删除/查询 LS',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_storage_log_replayer',
    item: {
      what: '存储层 redo 回放。回放失败意味着数据一致性有风险',
      verdict: 'bad',
      advice: '不要忽略；确认是否需要从备份恢复或联系原厂'
    }
  },
  {
    match: 'ob_storage_log_writer',
    item: {
      what: '存储层 redo 写入',
      verdict: 'normal'
    }
  },
  // ---- 事务与日志同步 ----
  {
    match: 'ob_trans_service',
    item: {
      what: '事务服务：事务的开始/提交/回滚与参与者管理',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_tx_data',
    item: {
      what: '事务数据（多版本行的未提交状态）',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_log_service',
    item: {
      what: 'clog（提交日志）服务：redo 的写入与同步',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_election',
    item: {
      what: '选举：选出每个副本组的 Leader',
      verdict: 'normal'
    }
  },
  {
    match: 'palf_handle_impl',
    item: {
      what: 'PALF 日志同步句柄：追加日志、推进复制位点',
      verdict: 'normal'
    }
  },
  {
    match: 'log_sliding_window',
    item: {
      what: '日志滑动窗口：维护"已提交到哪、已同步到哪"',
      verdict: 'normal'
    }
  },
  // ---- SQL 层 ----
  {
    match: 'ob_sql_audit',
    item: {
      what: 'SQL 审计：记录每条 SQL 的耗时、扫描行数等，供 gv$ob_sql_audit 查',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_plan_cache',
    item: {
      what: '执行计划缓存。命中率低会导致硬解析变多、CPU 升高',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_optimizer',
    item: {
      what: '查询优化器：选执行计划',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_sql_nio',
    item: {
      what: '客户端连接的异步 IO 层（收包、发包）',
      verdict: 'normal'
    }
  },
  // ---- 资源与均衡 ----
  {
    match: 'ob_unit_manager',
    item: {
      what: '资源单元（Unit）管理：给租户分配 CPU/内存',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_unit_allocator',
    item: {
      what: '资源单元分配计算',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_balance',
    item: {
      what: '负载均衡：调整副本分布，让各节点资源使用接近',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_locality_manager',
    item: {
      what: '副本位置（locality）管理：决定每个分区在哪些 zone 有副本',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_tenant_ctx_allocator',
    item: {
      what: '租户内存分配器：按 ctx（MemTable/缓存/其他）切分内存',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_io_manager',
    item: {
      what: 'IO 调度：给不同优先级的读写分配磁盘带宽',
      verdict: 'normal'
    }
  },
  // ---- 其他常用组件 ----
  {
    match: 'ob_inner_sql_connection',
    item: {
      what: '内部 SQL 连接：OB 自己发 SQL 读写系统表',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_schema_getter_guard',
    item: {
      what: 'schema 读取保护：拿表结构时加引用，防被 DDL 改掉',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_kvcache_store',
    item: {
      what: 'KVCache 存储层：缓存微块、行、schema 等',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_net_easy',
    item: {
      what: '网络框架（底层 socket 与事件循环）',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_server_blacklist',
    item: {
      what: '服务器黑名单：临时把某个异常节点排除在选主/RPC 之外',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_macro_block_handle',
    item: {
      what: '宏块（数据文件的物理存储单位）读写与句柄管理',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_eliminate_task',
    item: {
      what: '内存淘汰任务：把不常用的内存（如 SQL 审计记录）腾出来给更需要的模块',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_storage_ha_service',
    item: {
      what: '存储层高可用：副本迁移、补数据、追日志',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_tablet_mds_data',
    item: {
      what: '表级多源数据（MDS）：存表的辅助元信息，供内部一致读',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_vtable_location_service',
    item: {
      what: '分区位置缓存服务：维护"每个分区在哪个节点"的映射，读系统视图时要用',
      verdict: 'normal'
    }
  },
  {
    match: 'ob_occam_time_guard',
    item: {
      what: 'OCCAM 诊断框架的耗时打点：记录某段代码执行了多久',
      verdict: 'normal'
    }
  }
]

/** 模块前缀 → 解释。最后兜底用，至少能说清是哪个子系统 */
const MODULE_KB: { match: string; item: KbItem }[] = [
  { match: 'STORAGE.TRANS', item: { what: '事务与多版本存储层', verdict: 'normal' } },
  { match: 'STORAGE', item: { what: '存储层（表、分区、合并、GC）', verdict: 'normal' } },
  { match: 'PALF', item: { what: 'Paxos 日志同步框架（选主、复制日志）', verdict: 'normal' } },
  { match: 'CLOG', item: { what: '提交日志（redo）读写', verdict: 'normal' } },
  { match: 'ARCHIVE', item: { what: '日志归档/备份', verdict: 'normal' } },
  { match: 'SQL.RESV', item: { what: 'SQL 解析与语义检查', verdict: 'normal' } },
  { match: 'SQL.PC', item: { what: 'SQL 执行计划缓存', verdict: 'normal' } },
  { match: 'SQL', item: { what: 'SQL 引擎', verdict: 'normal' } },
  { match: 'RPC.OBMYSQL', item: { what: 'MySQL 协议层（客户端连接）', verdict: 'normal' } },
  { match: 'RPC.FRAME', item: { what: '节点间 RPC 框架', verdict: 'normal' } },
  { match: 'SHARE.LOCATION', item: { what: '分区位置信息缓存', verdict: 'normal' } },
  { match: 'SHARE', item: { what: '共享基础设施（位置、schema 等）', verdict: 'normal' } },
  { match: 'MDS', item: { what: '多源数据（分区元数据服务）', verdict: 'normal' } },
  { match: 'SERVER', item: { what: 'OBServer 主循环与后台线程', verdict: 'normal' } },
  { match: 'COMMON', item: { what: '公共基础组件', verdict: 'normal' } },
  { match: 'LIB', item: { what: '基础库（工具函数、内存、计时）', verdict: 'normal' } }
]

/**
 * 从一条日志样例里抠出三个锚点。
 * 形如：`[时间] WDIAG [STORAGE.TRANS] run1 (ob_standby_timestamp_service.cpp:147) [...]`
 *   module = STORAGE.TRANS（第一个方括号，在级别之后）
 *   file   = ob_standby_timestamp_service.cpp（最可靠的组件指纹）
 *   func   = run1（"(" 前最后一个词；OB 里常是 run1/stat 这类通用名，只能当次要依据）
 */
export function parseSite(sample?: string): { module: string; func: string; file: string } {
  if (!sample) return { module: '', func: '', file: '' }
  const mod = sample.match(/^\[[^\]]*\]\s+[A-Z]+\s+\[([^\]]*)\]/)
  const module = mod ? mod[1].trim() : ''
  const f = sample.match(/\(([A-Za-z_0-9.]+\.(?:cpp|h|ipp|cc|hpp|hxx)):\d+\)/)
  if (!f || f.index === undefined) return { module, func: '', file: '' }
  const before = sample.slice(0, f.index).replace(/\s+$/, '')
  const fn = before.match(/([A-Za-z_0-9]+)$/)
  return { module, file: f[1], func: fn ? fn[1] : '' }
}

const RANK: Record<ObVerdict, number> = { normal: 0, watch: 1, bad: 2 }

/**
 * 按「文件名 > 函数名」两轮匹配。文件名优先是刻意的：
 * OB 里很多日志的函数名是 run1 / stat / get_number，光看函数名分辨不出是哪个组件，
 * 而文件名（ob_standby_timestamp_service.cpp）唯一且跨版本稳定。
 */
function matchKb(file: string, func: string): { match: string; item: KbItem } | null {
  const f = (file || '').toLowerCase()
  if (f) {
    for (const k of SITE_KB) if (f.includes(k.match)) return k
  }
  const fn = (func || '').toLowerCase()
  if (fn) {
    for (const k of SITE_KB) if (fn.includes(k.match)) return k
  }
  return null
}

/** 文案匹配：拿日志正文里的英文短语兜底，键都写得足够具体，不会误伤 */
function matchText(sample?: string): { match: string; item: KbItem } | null {
  if (!sample) return null
  const low = sample.toLowerCase()
  for (const k of TEXT_KB) if (low.includes(k.match)) return k
  return null
}

/**
 * 解释一个错误码。三路证据取最严重的一档：
 *   错误码本身（最精确） / 报错文案（最具体） / 来源组件（能判断是否属于某类已知故障）
 * 例：-4076「需要等待」单看只是注意，但来自 standby 时间戳服务持续重试就是真问题。
 */
export function explainErrCode(code: string, sample?: string): ObExplain {
  const site = parseSite(sample)
  const base = ERRCODE_KB[code]
  const siteHit = matchKb(site.file, site.func)
  const txtHit = matchText(sample)

  if (base) {
    let verdict = base.verdict
    let advice = base.advice
    const extra: string[] = []
    let rule = `errcode:${code}`
    if (siteHit && RANK[siteHit.item.verdict] > RANK[verdict]) {
      verdict = siteHit.item.verdict
      advice = siteHit.item.advice || advice
      extra.push(siteHit.item.what)
      rule += `+site:${siteHit.match}`
    }
    if (txtHit && RANK[txtHit.item.verdict] > RANK[verdict]) {
      verdict = txtHit.item.verdict
      advice = txtHit.item.advice || advice
      extra.push(txtHit.item.what)
      rule += `+text:${txtHit.match}`
    }
    const what = extra.length ? `${base.what}。实际来源 —— ${extra.join('；')}` : base.what
    return { what, verdict, advice, rule }
  }

  // 错误码没收录：文案比数字有用得多
  if (txtHit) {
    return {
      what: `未收录的错误码 ${code}，但日志显示：${txtHit.item.what}`,
      verdict: txtHit.item.verdict,
      advice: txtHit.item.advice,
      rule: 'text:' + txtHit.match
    }
  }
  if (siteHit) {
    return {
      what: `未收录的错误码 ${code}；来源：${siteHit.item.what}`,
      verdict: siteHit.item.verdict,
      advice: siteHit.item.advice,
      rule: 'site:' + siteHit.match
    }
  }
  const byModule = matchModule(site.module)
  return {
    what: `未收录的错误码 ${code}${byModule ? `，来自${byModule.what}` : ''}`,
    verdict: 'watch',
    advice: '拿这条样例去搜 OB 错误码手册，或贴给原厂支持',
    rule: byModule ? 'module:' + byModule.match : 'fallback'
  }
}

/** 解释一个刷屏热点。site 是聚合键（`文件:行`），文件名从它上面切，比从样例切更可靠 */
export function explainHotSpot(site: string, sample?: string): ObExplain {
  const ps = parseSite(sample)
  const file = site.includes('.') && site.includes(':') ? site.slice(0, site.lastIndexOf(':')) : ps.file
  const hit = matchKb(file, ps.func)
  if (hit) {
    const advice = hit.item.verdict === 'normal'
      ? '正常后台任务，不需要处理；嫌日志多是另一回事（调 syslog_level 或扩日志盘）'
      : hit.item.advice
    return { what: hit.item.what, verdict: hit.item.verdict, advice, rule: 'site:' + hit.match }
  }
  const byModule = matchModule(ps.module)
  if (byModule) {
    return {
      what: `${byModule.what}的日常打点，未收录具体组件`,
      verdict: byModule.verdict,
      rule: 'module:' + byModule.match
    }
  }
  return {
    what: '未收录的位置，无法判断用途',
    verdict: 'watch',
    advice: '点开看原始日志行的正文，或按文件名搜 OB 源码',
    rule: 'fallback'
  }
}

function matchModule(module: string): { match: string; what: string; verdict: ObVerdict } | null {
  if (!module) return null
  for (const k of MODULE_KB) {
    if (module.toUpperCase().startsWith(k.match)) return { match: k.match, ...k.item }
  }
  return null
}

/** buildSummary 用的最小行结构：只要能算严重度就行，不依赖 oblog.ts 的完整类型 */
export interface SummaryRow {
  key: string
  count: number
  func?: string
  what?: string
  verdict?: ObVerdict
  advice?: string
  rule?: string
}

export interface SummaryLevel {
  key: string
  count: number
}

/** 整份统计压成的一句话结论：DBA 先看这个，再决定要不要往下翻 */
export interface ObLogSummary {
  level: 'ok' | 'watch' | 'bad'
  headline: string
  points: string[]
  /** 判为「正常」的日志行占比（%） */
  normalPct: number
  /** 判为「要处理」的行数 */
  badCount: number
  /** 判为「注意」的行数 */
  watchCount: number
}

/**
 * 把统计压成一句话结论。
 * 判断顺序照 DBA 的实际思路：先看有没有"要处理"的，再看"注意"的，都没有才说健康。
 * 数字口径统一用「判为 X 的日志行数」，而不是条目数 —— 20 个 watch 里有一个刷了 6000 次，
 * 和 20 条各刷 1 次，严重程度差两个数量级。
 */
export function buildSummary(
  total: number,
  levels: SummaryLevel[],
  hot: SummaryRow[],
  linesPerHour: number,
  errs: SummaryRow[] = []
): ObLogSummary {
  const sum = (rows: SummaryRow[], v: ObVerdict) => rows.filter((r) => r.verdict === v).reduce((a, r) => a + r.count, 0)
  // 热点覆盖全部日志行，错误码是热点的子集 —— 严重度以热点为准，避免重复计数
  const badCount = sum(hot, 'bad')
  const watchCount = sum(hot, 'watch')
  const normalPct = total > 0 ? Math.max(0, Math.min(100, (1 - (badCount + watchCount) / total) * 100)) : 100

  const points: string[] = []
  const warnPlus = levels.filter((l) => ['WARN', 'EDIAG', 'ERROR'].includes(l.key)).reduce((a, l) => a + l.count, 0)
  const wdiag = levels.find((l) => l.key === 'WDIAG')?.count || 0

  if (total > 0) {
    points.push(`窗口内 ${fmt(total)} 行日志，其中 ${normalPct.toFixed(1)}% 是正常后台任务打点，不必逐行看`)
  }

  const topBad = hot.filter((r) => r.verdict === 'bad').sort((a, b) => b.count - a.count)[0]
  const topWatch = hot.filter((r) => r.verdict === 'watch').sort((a, b) => b.count - a.count)[0]

  // 热点只留 Top40 —— 一个认证失败刷了 3 次，它的位置根本进不了榜，
  // 只按热点行数判级别就会把这种"低频但严重"的漏成健康。所以错误码表里判 bad 的
  // 必须能独立把级别拉起来，哪怕它的行数在总量里可以忽略。
  const badErrs = errs.filter((e) => e.verdict === 'bad').sort((a, b) => b.count - a.count)
  const rareBad = badErrs.filter((e) => !topBad || e.count < topBad.count * 0.01)

  if (topBad) {
    points.push(`主要问题：${topBad.func || topBad.key}（${fmt(topBad.count)} 次）—— ${topBad.what}`)
    if (topBad.advice) points.push(`处理建议：${topBad.advice}`)
  }
  if (warnPlus === 0 && total > 0) {
    points.push('WARN 及以上级别一条都没有 —— 集群当前没有报错，日志量来自正常刷屏')
  } else if (warnPlus > 0) {
    points.push(`WARN 及以上共 ${fmt(warnPlus)} 条，逐个看下面的错误码表`)
  }
  if (wdiag > 0) {
    points.push(`WDIAG（诊断信息）${fmt(wdiag)} 条 —— 它比 INFO 严重、比 WARN 轻，是 OB 提前打的"苗头"，数量大时值得挑着看`)
  }

  const topHot = hot[0]
  if (topHot && total > 0) {
    const p = (topHot.count / total) * 100
    points.push(`刷屏最多：${topHot.key} 占 ${p.toFixed(1)}%${topHot.func ? `（${topHot.func}）` : ''} —— ${topHot.what}`)
  }
  if (linesPerHour > 50_0000) {
    points.push(`日志量约 ${fmt(linesPerHour)} 行/小时，偏大：及时清理历史文件，或用 ALTER SYSTEM SET syslog_level='WARN' 压掉 INFO`)
  }
  if (rareBad.length) {
    const list = rareBad.slice(0, 3).map((e) => `${e.key}（${fmt(e.count)} 次）`).join('、')
    points.push(`另有低频但高危的错误码：${list} —— 次数少不等于没事，这几个都属于必须处理的类型`)
  }
  const notOurs = hot.filter((r) => r.rule === 'fallback')
  if (notOurs.length) {
    points.push(`有 ${notOurs.length} 个位置的解释库里没有，已标成"注意"，点开看正文再判断`)
  }

  const level: ObLogSummary['level'] = badCount > 0 || badErrs.length > 0 ? 'bad' : watchCount > 0 ? 'watch' : 'ok'
  const headline = topBad
    ? `发现 ${fmt(badCount)} 行需要处理的日志，源头是 ${topBad.func || topBad.key}`
    : badErrs.length
      ? `发现 ${badErrs.length} 个必须处理的错误码（低频但严重），首要的是 ${badErrs[0].key}：${badErrs[0].what || ''}`
      : topWatch
        ? `没有硬错误；但 ${fmt(watchCount)} 行值得留意（${topWatch.func || topWatch.key} 最集中）`
        : total > 0
          ? '没发现问题：窗口内全部是正常后台任务日志'
          : '窗口内没有可解析的日志，换个时间范围或日志类型试试'

  return { level, headline, points, normalPct, badCount, watchCount }
}

function fmt(n: number): string {
  return (Number(n) || 0).toLocaleString('en-US')
}
