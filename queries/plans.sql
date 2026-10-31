-- What each subscription in data/plans.json cost over the period vs the API-equivalent value of the usage it covered. Plan cost is prorated by day (a month's price spread over that month's days), so a 7-day view compares a week of usage with a week of the plan. `period` is the period's first day (status sets it; ./query uses the whole lake).
WITH days AS (
  SELECT d::DATE AS d
  FROM generate_series((SELECT start FROM period), current_date, INTERVAL 1 DAY) AS t(d)
),
paid AS (
  SELECT p.vendor, p.plan, min(days.d) AS first_day,
    sum(p.usd_per_month / day(last_day(days.d))) AS paid_usd
  FROM days JOIN plans p ON days.d >= p.since AND (p.until IS NULL OR days.d <= p.until)
  GROUP BY 1, 2
),
-- Usage on each day is credited to the plan active that day, so a plan switch mid-period splits cleanly.
used AS (
  SELECT p.vendor, p.plan, sum(coalesce(c.estimated_value_usd, 0)) AS usage_usd
  FROM classified c
  JOIN plans p ON p.vendor = c.vendor AND c.ts::DATE >= p.since AND (p.until IS NULL OR c.ts::DATE <= p.until)
  WHERE c.billing_mode = 'subscription'
  GROUP BY 1, 2
)
SELECT
  paid.plan,
  round(coalesce(used.usage_usd, 0), 2) AS api_value_usd,
  round(paid.paid_usd, 2) AS paid_usd,
  CASE WHEN paid.paid_usd > 0 THEN printf('%.1f×', coalesce(used.usage_usd, 0) / paid.paid_usd) END AS value_per_dollar
FROM paid LEFT JOIN used USING (vendor, plan)
ORDER BY paid.first_day, paid.plan;
