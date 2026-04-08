-- Atomic double-blind rating reveal.
-- Updates both feedback rows in a single transaction to prevent
-- inconsistent revealed state if one update fails.
CREATE OR REPLACE FUNCTION reveal_double_blind_ratings(
  feedback_id_a UUID,
  feedback_id_b UUID
) RETURNS void AS $$
BEGIN
  UPDATE a2a_task_feedback
  SET revealed = true, counterparty_feedback_id = feedback_id_b
  WHERE id = feedback_id_a;

  UPDATE a2a_task_feedback
  SET revealed = true, counterparty_feedback_id = feedback_id_a
  WHERE id = feedback_id_b;
END;
$$ LANGUAGE plpgsql;
