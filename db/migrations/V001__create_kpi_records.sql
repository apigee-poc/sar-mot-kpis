-- Migration V001: Create kpi_records table and grant SELECT to kpi_reader
CREATE TABLE IF NOT EXISTS kpi_records (
  kpi_code   VARCHAR(64)   NOT NULL,
  year       SMALLINT      NOT NULL CHECK (year BETWEEN 2000 AND 2099),
  quarter    SMALLINT      NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  actual     NUMERIC(20,4) NOT NULL CHECK (actual >= 0),
  load_time  TIMESTAMPTZ   NOT NULL,
  PRIMARY KEY (kpi_code, year, quarter)
);

GRANT SELECT ON kpi_records TO kpi_reader;
