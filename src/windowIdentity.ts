/** Full identity, including Unicode paths and project scope; never lossy truncation. */
export async function windowIdentity(kind:'ai'|'reader',parts:string[]):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify(parts));
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return kind+'-'+[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
