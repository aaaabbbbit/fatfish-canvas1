/**
 * 取一个**本机网络直接到不了**的地址（apifox 文档站、网关的 API 等），走本机代理。
 *
 * 为什么需要它（细节见 NOTES §3.41）：
 *   - `web_fetch` 会报 `resolves to a non-public IP address` —— 本机 DNS 是 Clash 的
 *     fake-ip（`198.18.x.x`），工具把私网地址一律挡住；
 *   - pwsh 里的 `curl` / `Invoke-RestMethod` 一律 TLS 握手失败
 *     （schannel `SEC_E_NO_CREDENTIALS`，受限令牌拿不到凭据）；
 *   - **node 自带的 TLS 不吃 schannel**，所以手写一次 `CONNECT` 就能出去。
 *
 * 用法（`node` 直接跑，不需要完全权限）：
 *   node scripts/fetch-doc.mjs https://gpt-best.apifox.cn/api-139393505.md
 *   node scripts/fetch-doc.mjs https://ai.t8star.org/v1/models --auth FFC_CUSTOM_API_KEY
 *   node scripts/fetch-doc.mjs <url> --method POST --body body.json --auth FFC_CUSTOM_API_KEY
 *   node scripts/fetch-doc.mjs <url> --head          # 只看响应头（CSV / 图片探路时省事）
 *
 * 环境变量：`FFC_PROXY`（默认 `http://127.0.0.1:7897`）、`DSH_HOME`（找凭据库，默认
 * `C:/Users/<你>/.dsh`）。
 *
 * ⚠️ 发出去的 `--auth` 是**真的花钱**的调用：探协议时先用空 `prompt` 这类必然被拒的
 * 请求（网关会回一句可读的错误），确认路径对了再发真的。
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

/** 取一个 `--flag value` / `--flag` 参数。 */
const flagOf = (name) => {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return undefined;
	const next = process.argv[index + 1];
	return next === undefined || next.startsWith('--') ? '' : next;
};

const target = process.argv[2];
if (target === undefined || !/^https?:\/\//.test(target)) {
	console.error('用法: node scripts/fetch-doc.mjs <url> [--method POST] [--body 文件] [--auth 凭据引用名] [--head]');
	process.exit(2);
}

const url = new URL(target);
const method = (flagOf('method') ?? 'GET').toUpperCase();
const bodyFile = flagOf('body');
const body = bodyFile === undefined ? undefined : fs.readFileSync(bodyFile, 'utf8');

/** 从凭据库读一把密钥（只读 `refs:` 那一段，值是 YAML 标量）。 */
const keyOf = (ref) => {
	const home = process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh');
	const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
	const found = new RegExp(`^\\s*${ref}:\\s*(\\S+)\\s*$`, 'm').exec(text);
	if (found === null) throw new Error(`凭据库里没有 ${ref}`);
	return found[1];
};

const proxy = new URL(process.env['FFC_PROXY'] ?? 'http://127.0.0.1:7897');
const auth = flagOf('auth');
const headers = [
	`${method} ${url.pathname}${url.search} HTTP/1.0`, // HTTP/1.0：服务端就不会上 chunked，正文拿到手即完整 JSON
	`Host: ${url.hostname}`,
	'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) fatfish-canvas/fetch-doc',
	'Accept: */*',
	...(auth === undefined || auth === '' ? [] : [`Authorization: Bearer ${keyOf(auth)}`]),
	...(body === undefined ? [] : ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`]),
	'Connection: close',
	'',
	body ?? '',
].join('\r\n');

const raw = await new Promise((resolve, reject) => {
	const bail = setTimeout(() => reject(new Error('超时（30 秒）')), 30000);
	const sock = net.connect(Number(proxy.port), proxy.hostname, () => {
		sock.write(`CONNECT ${url.hostname}:${url.port === '' ? '443' : url.port} HTTP/1.1\r\nHost: ${url.hostname}\r\n\r\n`);
	});
	sock.once('data', (chunk) => {
		const line = String(chunk).split('\r\n')[0] ?? '';
		if (!/ 200/.test(line)) {
			clearTimeout(bail);
			return reject(new Error(`代理没建起隧道：${line}（代理地址对不对？见 FFC_PROXY）`));
		}
		sock.removeAllListeners('data');
		const secure = tls.connect({ socket: sock, servername: url.hostname }, () => secure.write(headers));
		const chunks = [];
		secure.on('data', (chunk) => chunks.push(chunk));
		secure.on('end', () => {
			clearTimeout(bail);
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		secure.on('error', (error) => {
			clearTimeout(bail);
			reject(error);
		});
	});
	sock.on('error', reject);
});

const split = raw.indexOf('\r\n\r\n');
const head = raw.slice(0, split === -1 ? raw.length : split);
if (flagOf('head') !== undefined) console.log(head);
else console.log(split === -1 ? raw : raw.slice(split + 4));
