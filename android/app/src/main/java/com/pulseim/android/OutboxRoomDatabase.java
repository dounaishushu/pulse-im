package com.pulseim.android;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.room.Database;
import androidx.room.Room;
import androidx.room.RoomDatabase;
import androidx.room.migration.Migration;
import androidx.sqlite.db.SupportSQLiteDatabase;
import java.io.File;
import java.util.List;
import java.util.function.BiConsumer;

/** One file/connection owner: legacy records and Room deltas share the same SQLite commit. */
@Database(entities = {AccountRecordEntity.class, OutboxEntity.class, OutboxMetadata.class}, version = 2, exportSchema = false)
public abstract class OutboxRoomDatabase extends RoomDatabase {
    static volatile BiConsumer<String, List<?>> trace;
    public abstract OutboxDao outbox();
    static OutboxRoomDatabase open(Context context) {
        Builder<OutboxRoomDatabase> builder = Room.databaseBuilder(context.getApplicationContext(), OutboxRoomDatabase.class,
                new File(context.getApplicationContext().getNoBackupFilesDir(), "local-account-v1.db").getAbsolutePath())
                .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
                .addMigrations(new Migration(1, 2) {
                    @Override public void migrate(@NonNull SupportSQLiteDatabase db) {
                        db.execSQL("CREATE TABLE IF NOT EXISTS `outbox` (`accountKey` TEXT NOT NULL, `namespace` TEXT NOT NULL, `requestId` TEXT NOT NULL, `position` INTEGER NOT NULL, `createdAt` INTEGER NOT NULL, `data` BLOB NOT NULL, PRIMARY KEY(`accountKey`,`namespace`,`requestId`))");
                        db.execSQL("CREATE TABLE IF NOT EXISTS `outbox_metadata` (`accountKey` TEXT NOT NULL, `namespace` TEXT NOT NULL, `data` BLOB NOT NULL, PRIMARY KEY(`accountKey`,`namespace`))");
                    }
                });
        if (BuildConfig.DEBUG) builder.setQueryCallback((sql, args) -> {
            BiConsumer<String, List<?>> observer = trace;
            if (observer != null) observer.accept(sql, args);
        }, Runnable::run);
        return builder.build();
    }
}
