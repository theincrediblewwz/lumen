/** Board-relative links remain inside the current board and resolve only mounted documents. */
export function localDocumentPath(href:string):string|null{
 let path:string;try{path=decodeURIComponent(href.split('#')[0]);}catch{return null;}
 const match=/^(?:\.\/)?(?:docs\/)?([^/\\:?\u0000]+\.md)$/i.exec(path);
 if(!match||match[1].length>240||match[1]==='..'||match[1].startsWith('..'))return null;
 return `docs/${match[1]}`;
}
