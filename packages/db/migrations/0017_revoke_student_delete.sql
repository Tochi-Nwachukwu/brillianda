-- Students are only ever soft-deleted (deleted_at), including when an import is undone. The API
-- role never needs to delete a student row, so it can't.
REVOKE DELETE ON students FROM brillianda_app;
