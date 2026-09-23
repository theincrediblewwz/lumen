export function normalizePublicWebUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('请输入完整的 http:// 或 https:// 网页地址');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('网页地址只支持 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('网页地址不能包含账号或密码');
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.local')
    || hostname.includes(':')
    || isPrivateIpv4(hostname)
  ) {
    throw new Error('为了保护本机和局域网数据，不能读取本地或私有网络地址');
  }
  url.hash = '';
  return url.toString();
}

export function isPrivateIpv4(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return false;
  const parts = hostname.split('.').map(Number);
  if (parts.some((value) => value < 0 || value > 255)) return true;
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || parts[0] >= 224
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}
