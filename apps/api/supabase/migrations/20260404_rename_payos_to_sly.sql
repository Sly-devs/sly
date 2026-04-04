-- Rename payos_native → sly_native and payos_latam → sly_latam
-- We are no longer PayOS — the platform is now Sly.

UPDATE payment_handlers SET id = 'sly_latam', name = 'com.sly.latam_settlement', display_name = 'Sly LATAM Settlement' WHERE id = 'payos_latam';
UPDATE connected_accounts SET handler_type = 'sly_native' WHERE handler_type = 'payos_native';
