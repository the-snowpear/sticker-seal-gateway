# 贴纸封印网关 · sticker-seal-gateway

把一段提示词（贴纸 A）和一段封印（贴纸 B）**夹进 system 槽**的透明网关，插在
[sub2api](https://github.com/Wei-Shaw/sub2api) 和它背后的转换器（workbuddy2api-hub、
cmdcode2api、antigravity-manager……）之间。对客户端和 sub2api 都不可见，除了
system 槽变了，其它字节一个都没动。

管理界面挂进 sub2api 后台侧栏（自定义菜单 iframe），登录态复用 sub2api 自己的
JWT，没有第二套账号。

```
客户端 → sub2api → 账号调度 → sticker-seal:9001|9002|9003 → 上游转换器 → 真上游
浏览器 → sub2api 侧栏「贴纸封印」→ iframe /seal/?token=… → sticker-seal:6030
```

## 为什么是这一层

sub2api 自己已经有插件系统，但当前版本的能力白名单只有
`openai.oauth.outbound_transport.v1`（`backend/internal/service/plugin_manifest.go`），
只接管 `platform=openai && type=oauth` 的账号，而且要求插件自己实现整条出站 HTTP
传输。真实流量里绝大多数是 `apikey` 账号，从 `/v1/chat/completions` 出去，插件层
接不住。

把网关插在 sub2api 与转换器之间，覆盖全部 apikey 通道，而且上游入口形状单一：
sub2api 已经把 `/v1/responses`、`/v1/messages` 归一化成 `/v1/chat/completions` 再发出去，
所以这里只需要处理一种 JSON。

## 注入契约

只处理 `POST` + `content-type: application/json` + 路径命中三种之一：

| 路径 | 注入位置 |
|---|---|
| `…/v1/chat/completions` | **第一条** `role=="system"` 的 `content`（字符串拼接 / 块数组头尾插块 / 缺失则在 `messages[0]` 前插一条 system） |
| `…/v1/responses` | `instructions` 字符串前后拼；缺失则往 `input` 前插 `{role:"system",content:[{type:"input_text",…}]}` |
| `…/v1/messages` | `system` 字符串拼接 / 块数组头尾插块 / 缺失则补字符串 |

规则：

- 消息条数不变（除了「本来没有 system」这种情况），第二条起的 system 消息原样不动
  —— 上游对多 system 的处理差异、tool-call 顺序都不会被搅乱。
- 命中 `dedupe` 时，system 文本已经以贴纸 A 前 64 字节开头就跳过，记 `already-sealed`
  （客户端自己已经带贴纸时不会叠加两遍）。
- 其余一切请求（GET、`/v1/models`、非 JSON、`content-encoding` 非 identity、超过
  `max_body_bytes`）零改动透传，响应不缓冲，SSE 逐块下发。

## 实测数据

2026-10-30 在一台真实 sub2api 0.2.19 部署上跑通（DeepSeek-V4-Flash，`/v1/chat/completions`）：

| 项目 | 数值 |
|---|---|
| 贴纸 | A 25,032 字符 + B 1,068 字符 = 26,100 字符 |
| 上游实际 prompt token | **7,376**（含客户端 ~30 token） |
| 其中命中 prompt cache | **7,296**，冷启动只有 82 新鲜 token |
| 注入后 body sha256 | 打到两个不同上游时完全一致，说明改写是确定性的 |
| 端到端时延 | 直连 1.75 s / 经网关 2.19 s，同量级 |
| 客户端拿到的回答 | 按贴纸人格作答（"（充满占有欲的看着你）……"），封印生效 |

关于计费：sub2api 读的是上游回传的 `usage`。它的 `input_tokens` 记的是**非缓存**部分，缓存部分单列在 `cache_read_tokens`，两者相加才等于上游的 prompt 总数。上面那次请求在 `usage_logs` 里落成 `input_tokens=82 / cache_read_tokens=7296`。也就是说贴纸的 token **会**进账，只是绝大部分按缓存价计。贴纸放在 system 槽最前、每次字节完全相同，正好把整段贴纸变成可缓存前缀。

另外注意：sub2api 给 `openai` apikey 账号做的 Responses 能力探测（`POST /v1/responses`，模型名来自账号配置）也会被注入，事件里是 `inserted-input-system`。探测只看状态码，多出来的 system 项不影响结果，属于已知且无害的行为。

## 快速开始

```bash
# 1. 代码落到服务器
git clone <this-repo> /home/ubuntu/sticker-seal-gateway
cd /home/ubuntu/sticker-seal-gateway

# 2. 数据目录（容器内是 uid 1000）
mkdir -p data

# 3. JWT 密钥：与 sub2api 容器的 JWT_SECRET 一致
export SUB2API_JWT_SECRET="$(docker inspect sub2api --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^JWT_SECRET=//p')"

# 4. 起
docker compose up -d --build
curl -s http://127.0.0.1:6030/_seal/api/health
```

然后在 sub2api 后台「系统设置 → 自定义菜单」里加一条，指向
`https://<你的域名>/seal/`，可见性 `admin`：

```json
{
  "id": "sticker_seal",
  "label": "贴纸封印",
  "icon_svg": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"4\"/><path d=\"M7.5 12.5l3 3 6-6\"/></svg>",
  "url": "https://snowpear.mom/seal/",
  "visibility": "admin",
  "sort_order": 30,
  "hide_open_button": true
}
```

nginx 侧（照抄一份现有侧栏页面的写法）：

```nginx
location = /seal { return 301 $http_x_forwarded_proto://$http_x_forwarded_host/seal/; }
location /seal/ {
    proxy_pass http://127.0.0.1:6030/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /seal;
    proxy_set_header Accept-Encoding "";
    proxy_hide_header X-Frame-Options;
    proxy_hide_header Content-Security-Policy;
    proxy_hide_header Content-Security-Policy-Report-Only;
    proxy_read_timeout 600s;
    proxy_buffering off;
}
```

## 配置

`data/config.json`，GUI 写、进程热读，改完不用重启。

```json
{
  "version": 1,
  "stickers": {
    "prefix": "贴纸 A 全文",
    "suffix": "贴纸 B 全文",
    "dedupe": true,
    "max_body_bytes": 134217728
  },
  "upstreams": [
    {
      "id": "wb",
      "name": "WorkBuddy 网关",
      "listen": 9001,
      "target": "http://wb-proxy:8788",
      "enabled": true,
      "model_allow": [],
      "account_id": 31,
      "previous_base_url": "http://wb-proxy:8788"
    }
  ],
  "admin": { "listen": 6030, "sub2api_base": "http://sub2api:8080" }
}
```

- `listen` 落在 9000–9100，端口唯一，运行期热绑定/解绑，不需要改 compose、不需要
  映射主机端口（容器间走 docker 网络）。
- `model_allow` 为空 = 所有模型；支持 `*` / `?` 通配，大小写不敏感。
- `account_id` 是「接入」按钮要改的 sub2api 账号。
- `previous_base_url` 是接入前的原值，「断开」按它还原。

## API

除 `health` 外都需要 `Authorization: Bearer <sub2api admin JWT>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/_seal/api/health` | 探活 |
| GET | `/_seal/api/state` | 贴纸、上游、运行态、当日计数 |
| GET | `/_seal/api/accounts` | 代理 sub2api 账号列表（只留展示需要的字段） |
| GET | `/_seal/api/events?limit=100` | 最近事件 |
| PUT | `/_seal/api/stickers` | `{prefix,suffix,dedupe,max_body_bytes}` |
| PUT | `/_seal/api/upstreams` | `{upstreams:[…]}` 整体替换 |
| POST | `/_seal/api/preview` | `{upstream_id,path,body}` → 注入后文本，不转发 |
| POST | `/_seal/api/test` | `{upstream_id,path,body,headers}` → 实打上游，回执截断 256 KiB |
| POST | `/_seal/api/attach` | `{upstream_id,account_id?}` → 改 sub2api 账号 base_url |
| POST | `/_seal/api/detach` | `{upstream_id}` → 还原 |

`attach` / `detach` 走的是 sub2api 的 `PUT /api/v1/admin/accounts/:id`，并且会先把
**脱敏后的完整 credentials 读回来**再改 `base_url` —— sub2api 的合并语义是「敏感键
缺失就保留、非敏感键整体由传入决定」，只发 `{base_url}` 会把 `model_mapping` 冲掉。

## 运维

```bash
docker compose logs -f --tail=100        # 运行日志
docker exec sticker-seal cat /app/data/config.json | head -40
docker compose restart
docker compose down                      # 拔掉网关（记得先「断开」账号）
```

紧急止血（不改任何配置文件，立刻停止注入）：

```bash
# 方式一：把贴纸清空 —— 所有请求变成纯透传
curl -s -X PUT http://127.0.0.1:6030/_seal/api/stickers \
  -H "Authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"prefix":"","suffix":""}'

# 方式二：sub2api 里把账号 base_url 改回原值（GUI 的「断开」按钮等价）
```

## 排障

| 现象 | 查什么 |
|---|---|
| 侧栏 iframe 空白 | nginx 是否 `proxy_hide_header X-Frame-Options`；`/_seal/api/health` 是否 200 |
| GUI 报 401 | `SUB2API_JWT_SECRET` 与 sub2api 容器 `JWT_SECRET` 是否一致；URL 上有没有 `?token=` |
| `docker exec sub2api curl http://sticker-seal:9001/v1/models` 连不上 | 容器是否挂在 `sub2api-deploy_sub2api-network`；`data/config.json` 里 `enabled` 是否为 true |
| 事件里全是 `path-not-injected` | 该账号走的不是 chat/completions，看看 `usage_logs.upstream_endpoint` |
| 事件里全是 `already-sealed` | 客户端自己已经贴过（例如 DSH 装了 dsh-sticker-seal），属正常 |
| 上游报 400 / 内容错乱 | 先用「预览与测试」看注入后 JSON；多半是客户端把 system 放在了非首条 |
| 账号突然 502 | 网关没起或者端口没监听，看 `docker compose logs` |
| `docker exec sub2api curl http://sticker-seal:9001/v1/models` 报 connection refused | 该端口没有监听（upstream 被停用或端口写错），sub2api 会按账号失败处理并走故障转移 |

## 开发

```bash
node --test test/*.test.js     # 36 个用例，无外部依赖
node tools/build-defaults.mjs  # 从 dsh-sticker-seal 的 injection/*.md 重建 defaults/stickers.json
```

零运行时依赖：只用 `node:http` / `node:fs` / `node:crypto`。Node ≥ 20。

## License

MIT
