// oracledb 6.x npm 包未附带类型声明，运行时为纯 JS（thin 模式），这里做环境声明
declare module 'oracledb'

// CodeMirror 5 无自带类型，仅以松散类型使用（getValue/setValue/getSelection/refresh/on）
declare module 'codemirror'
declare module 'codemirror/mode/sql/sql.js'
declare module 'codemirror/theme/material-darker.css'
