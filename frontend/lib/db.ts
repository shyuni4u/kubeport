import { Pool } from "pg";

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set");
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const p = getPool();
    const v = Reflect.get(p, prop, p);
    return typeof v === "function" ? v.bind(p) : v;
  },
});
