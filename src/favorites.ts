type Favorites = { projects: string[]; boards: string[] };
export function loadFavorites(root: string): Favorites {
  try { const value=JSON.parse(localStorage.getItem(`lumen.favorites.v1:${root}`) ?? '{}');
    const clean=(v:unknown)=>Array.isArray(v)?[...new Set(v.filter((id):id is string=>typeof id==='string'))]:[];
    return {projects:clean(value.projects),boards:clean(value.boards)};
  } catch { return {projects:[],boards:[]}; }
}
export function saveFavorites(root:string,value:Favorites) { localStorage.setItem(`lumen.favorites.v1:${root}`,JSON.stringify(value)); }
export function pinnedFirst<T extends {id:string}>(items:T[], pinned:string[]): T[] {
  const ids=new Set(pinned);return [...items.filter(v=>ids.has(v.id)),...items.filter(v=>!ids.has(v.id))];
}
