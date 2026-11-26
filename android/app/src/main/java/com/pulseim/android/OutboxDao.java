package com.pulseim.android;

import androidx.room.Dao;
import androidx.room.Query;
import androidx.room.Upsert;
import java.util.List;

@Dao
public interface OutboxDao {
    @Upsert void upsert(OutboxEntity row);
    @Upsert void upsert(OutboxMetadata metadata);
    @Query("SELECT * FROM outbox WHERE accountKey=:scope AND namespace=:namespace ORDER BY position,requestId")
    List<OutboxEntity> rows(String scope, String namespace);
    @Query("SELECT * FROM outbox WHERE accountKey=:scope AND namespace=:namespace AND requestId=:id")
    OutboxEntity row(String scope, String namespace, String id);
    @Query("SELECT requestId,position,createdAt,length(data) AS byteCount FROM outbox WHERE accountKey=:scope AND namespace=:namespace ORDER BY position,requestId")
    List<OutboxRowHeader> headers(String scope, String namespace);
    @Query("SELECT requestId,position,createdAt,length(data) AS byteCount FROM outbox WHERE accountKey=:scope AND namespace=:namespace AND requestId=:id")
    OutboxRowHeader header(String scope, String namespace, String id);
    @Query("SELECT substr(data,:offset,:count) FROM outbox WHERE accountKey=:scope AND namespace=:namespace AND requestId=:id")
    byte[] chunk(String scope, String namespace, String id, int offset, int count);
    @Query("SELECT * FROM outbox_metadata WHERE accountKey=:scope AND namespace=:namespace")
    OutboxMetadata metadata(String scope, String namespace);
    @Query("DELETE FROM outbox WHERE accountKey=:scope AND namespace=:namespace AND requestId=:id")
    void delete(String scope, String namespace, String id);
    @Query("DELETE FROM outbox WHERE accountKey=:scope AND namespace=:namespace")
    void clear(String scope, String namespace);
    @Query("DELETE FROM outbox_metadata WHERE accountKey=:scope AND namespace=:namespace")
    void deleteMetadata(String scope, String namespace);
}
