import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from './client.js';
import { toJsonb, fromJsonb } from './jsonb.js';

describe('JSONB encoding/decoding', () => {
  beforeAll(async () => {
    // Create test table with various jsonb columns
    await pool.query(`
      CREATE TEMP TABLE jsonb_test (
        id SERIAL PRIMARY KEY,
        simple_obj JSONB,
        nested_obj JSONB,
        array_val JSONB,
        nested_array JSONB,
        null_val JSONB
      )
    `);
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS jsonb_test');
  });

  it('should round-trip simple objects', async () => {
    const input = { key: 'value', num: 42, bool: true };
    
    const result = await pool.query(
      'INSERT INTO jsonb_test (simple_obj) VALUES ($1) RETURNING simple_obj',
      [toJsonb(input)]
    );
    
    expect(result.rows[0].simple_obj).toEqual(input);
  });

  it('should round-trip deeply nested objects', async () => {
    const input = {
      level1: {
        level2: {
          level3: {
            array: [1, 2, 3],
            nested: { key: 'value' },
          },
        },
        sibling: 'test',
      },
      top: [{ a: 1 }, { b: 2 }],
    };
    
    const result = await pool.query(
      'INSERT INTO jsonb_test (nested_obj) VALUES ($1) RETURNING nested_obj',
      [toJsonb(input)]
    );
    
    expect(result.rows[0].nested_obj).toEqual(input);
  });

  it('should round-trip arrays with objects', async () => {
    const input = [
      { id: 'q1', type: 'choice', options: [{ value: 'a', label: 'A' }] },
      { id: 'q2', type: 'text', constraints: { minLength: 5, maxLength: 100 } },
    ];
    
    const result = await pool.query(
      'INSERT INTO jsonb_test (array_val) VALUES ($1) RETURNING array_val',
      [toJsonb(input)]
    );
    
    expect(result.rows[0].array_val).toEqual(input);
  });

  it('should round-trip nested arrays', async () => {
    const input = {
      steps: [
        {
          id: 'step1',
          actions: [
            { command: { type: 'approve_plan', payload: { planId: 'abc', approved: true } } },
          ],
        },
      ],
    };
    
    const result = await pool.query(
      'INSERT INTO jsonb_test (nested_array) VALUES ($1) RETURNING nested_array',
      [toJsonb(input)]
    );
    
    expect(result.rows[0].nested_array).toEqual(input);
  });

  it('should handle null values', async () => {
    const result = await pool.query(
      'INSERT INTO jsonb_test (null_val) VALUES ($1) RETURNING null_val',
      [toJsonb(null)]
    );
    
    expect(result.rows[0].null_val).toBeNull();
  });

  it('should handle undefined as null', async () => {
    const result = await pool.query(
      'INSERT INTO jsonb_test (null_val) VALUES ($1) RETURNING null_val',
      [toJsonb(undefined)]
    );
    
    expect(result.rows[0].null_val).toBeNull();
  });

  it('should round-trip UI props with special characters', async () => {
    const input = {
      title: 'Test "quoted" value',
      description: "Line 1\nLine 2\tTabbed",
      json: '{"nested": "json"}',
      unicode: '测试 émojis 🎉',
    };
    
    const result = await pool.query(
      'INSERT INTO jsonb_test (simple_obj) VALUES ($1) RETURNING simple_obj',
      [toJsonb(input)]
    );
    
    expect(result.rows[0].simple_obj).toEqual(input);
  });

  it('should prevent double-encoding regression', async () => {
    // This was the original bug: if we double-stringify, Postgres rejects it
    const input = { key: 'value', nested: { array: [1, 2, 3] } };
    const encoded = toJsonb(input);
    
    // Verify it's a string
    expect(typeof encoded).toBe('string');
    
    // Verify it's valid JSON
    expect(() => JSON.parse(encoded!)).not.toThrow();
    
    // Verify it decodes to the original
    expect(JSON.parse(encoded!)).toEqual(input);
    
    // Insert and verify no error
    await expect(
      pool.query('INSERT INTO jsonb_test (simple_obj) VALUES ($1)', [encoded])
    ).resolves.not.toThrow();
  });
});
