-- Realtime fan-out triggers for the agent runtime (design §6.3).
--
-- Drizzle does not model PL/pgSQL functions or triggers, so this migration
-- is hand-written. Two channels are installed:
--
--   agent_messages_channel — fires on every INSERT. Workers LISTEN to wake
--     up immediately instead of polling claim_next.
--
--   human_actions_channel — fires on INSERT and on status changes. The
--     admin UI subscribes to render the inbox in real time; the WhatsApp
--     escalator picks up the same stream.
--
-- Payloads are intentionally tiny: just the IDs and routing fields the
-- listener needs to fetch the full row from Postgres if it cares.
-- pg_notify's payload limit is 8KB; sticking to scalars + UUIDs keeps us
-- well under that even when the channel is hot.

CREATE OR REPLACE FUNCTION notify_agent_messages() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('agent_messages_channel', json_build_object(
    'id', NEW.id,
    'to_role', NEW.to_role,
    'to_instance', NEW.to_instance,
    'intent', NEW.intent,
    'correlation_id', NEW.correlation_id,
    'priority', NEW.priority,
    'created_at', NEW.created_at
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_messages_insert_notify
  AFTER INSERT ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION notify_agent_messages();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_human_actions() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('human_actions_channel', json_build_object(
    'id', NEW.id,
    'op', TG_OP,
    'status', NEW.status,
    'severity', NEW.severity,
    'correlation_id', NEW.correlation_id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER human_actions_insert_notify
  AFTER INSERT ON human_actions
  FOR EACH ROW EXECUTE FUNCTION notify_human_actions();
--> statement-breakpoint
CREATE TRIGGER human_actions_update_notify
  AFTER UPDATE OF status ON human_actions
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION notify_human_actions();
