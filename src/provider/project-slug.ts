// src/provider/project-slug.ts — path → x-project-slug (PLAN #8, port of pi's
// projectSlugFromPath)
export function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}
