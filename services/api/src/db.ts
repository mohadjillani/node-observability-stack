import pg from 'pg';

const { Pool } = pg;

export type OrderStatus = 'queued' | 'priced' | 'failed';

export interface Order {
  readonly id: string;
  readonly sku: string;
  readonly quantity: number;
  readonly status: OrderStatus;
  readonly totalCents: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewOrder {
  readonly id: string;
  readonly sku: string;
  readonly quantity: number;
}

export interface OrdersStore {
  insert(order: NewOrder): Promise<Order>;
  get(id: string): Promise<Order | undefined>;
  ping(): Promise<void>;
}

export interface Database extends OrdersStore {
  /** Creates the `orders` table when missing. A demo-sized substitute for a migration runner. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

interface OrderRow {
  id: string;
  sku: string;
  quantity: number;
  status: OrderStatus;
  total_cents: number | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, sku, quantity, status, total_cents, created_at, updated_at';

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 5 });

  return {
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id          uuid PRIMARY KEY,
          sku         text NOT NULL,
          quantity    integer NOT NULL,
          status      text NOT NULL,
          total_cents integer,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now()
        )`);
    },

    async insert(order) {
      const result = await pool.query<OrderRow>(
        `INSERT INTO orders (id, sku, quantity, status) VALUES ($1, $2, $3, 'queued') RETURNING ${COLUMNS}`,
        [order.id, order.sku, order.quantity],
      );
      const row = result.rows[0];
      if (!row) throw new Error('insert returned no row');
      return toOrder(row);
    },

    async get(id) {
      const result = await pool.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE id = $1`, [
        id,
      ]);
      const row = result.rows[0];
      return row ? toOrder(row) : undefined;
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    close: () => pool.end(),
  };
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    sku: row.sku,
    quantity: row.quantity,
    status: row.status,
    totalCents: row.total_cents,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
