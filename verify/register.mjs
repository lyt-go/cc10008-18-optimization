// 注册 '@/' 别名解析到 frontend/src，供 node 直接验证服务层。
import { register } from 'node:module'
register('./alias-loader.mjs', import.meta.url)
