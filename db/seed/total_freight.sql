-- Idempotent mock data for total_freight KPI
INSERT INTO kpi_records (kpi_code, year, quarter, actual, load_time)
VALUES
  -- 2024 full four-quarter baseline
  ('total_freight', 2024, 1, 1350000.0000, '2024-04-05T02:00:00Z'),
  ('total_freight', 2024, 2, 1395000.0000, '2024-07-05T02:00:00Z'),
  ('total_freight', 2024, 3, 1480000.0000, '2024-10-05T02:00:00Z'),
  ('total_freight', 2024, 4, 1520000.0000, '2025-01-05T02:00:00Z'),
  -- 2025 OAS example rows (Q1-Q3 only, Q4 omitted on purpose)
  ('total_freight', 2025, 1, 1420500.0000, '2025-04-05T02:00:00Z'),
  ('total_freight', 2025, 2, 1388200.0000, '2025-07-05T02:00:00Z'),
  ('total_freight', 2025, 3, 1512750.0000, '2025-10-05T02:00:00Z')
ON CONFLICT (kpi_code, year, quarter) DO UPDATE SET
  actual = EXCLUDED.actual,
  load_time = EXCLUDED.load_time;
