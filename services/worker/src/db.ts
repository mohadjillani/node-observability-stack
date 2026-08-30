import pg from 'pg';

const { Pool } = pg;

export interface OrderWriter {
  markPriced(id: string, totalCents: number): Promise<void>;
  markFailed(id: string): Promise<void>;
  ping(): Promise<void>;
}

export interface Database extends OrderWriter {
  close(): Promise<void>;
}

/** The worker only ever updates rows the api created; the table is the api's. */
export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 5 });
  return {
    async markPriced(id, totalCents) {
      await pool.query(
        `UPDATE orders SET status = 'priced', total_cents = $2, updated_at = now() WHERE id = $1`,
        [id, totalCents],
      );
    },
    async markFailed(id) {
      await pool.query(`UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1`, [
        id,
      ]);
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    close: () => pool.end(),
  };
}
