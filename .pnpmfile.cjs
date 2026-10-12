// pnpm install hooks. Keep this file minimal and reviewed: it runs on every install.

/**
 * @prisma/client declares the Prisma CLI and TypeScript as *optional* peers. Because the
 * API has both as devDependencies, pnpm links them to the client, and they then leak
 * into the production deployment (CLI, Studio, embedded Postgres, TypeScript: ~350 MB).
 * The generated client only needs `@prisma/client/runtime/*` at run time, so the peers
 * are dropped here. `prisma generate` still uses the API's own `prisma` devDependency.
 */
function readPackage(pkg) {
  if (pkg.name === '@prisma/client') {
    for (const peer of ['prisma', 'typescript']) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[peer];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
