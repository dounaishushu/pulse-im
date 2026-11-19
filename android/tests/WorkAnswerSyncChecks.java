package com.pulseim.android;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Exercises delayed/failing writes without a server or Android framework. */
public final class WorkAnswerSyncChecks {
    private static int passed;
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void waitFor(CountDownLatch latch) throws Exception { require(latch.await(3, TimeUnit.SECONDS), "timed out"); }
    public static void main(String[] args) throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), saved = new CountDownLatch(2);
            List<Map<String, Boolean>> writes = Collections.synchronizedList(new ArrayList<>());
            WorkAnswerSync sync = new WorkAnswerSync(worker, batch -> {
                writes.add(new LinkedHashMap<>(batch));
                if (writes.size() == 1) { entered.countDown(); waitFor(release); }
                saved.countDown();
            }, () -> true, error -> require(error == null, "unexpected save failure"));
            sync.enqueue(Map.of("q0", true)); waitFor(entered);
            long start = System.nanoTime();
            for (int i=1;i<=100;i++) sync.enqueue(Map.of("q"+i, i%2==0));
            sync.enqueue(Map.of("q1", true)); sync.enqueue(Map.of("q1", false));
            require(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<250, "UI enqueue waited for the network");
            release.countDown(); waitFor(saved); worker.submit(() -> {}).get(3,TimeUnit.SECONDS);
            require(writes.size()==2 && writes.get(1).size()==100, "answers were not coalesced");
            require(Boolean.FALSE.equals(writes.get(1).get("q1")), "latest answer was overwritten");
            passed+=3; System.out.println("PASS delayed writes do not block selection; 100 queued answers coalesce; latest false wins");

            AtomicInteger attempts=new AtomicInteger(); CountDownLatch failure=new CountDownLatch(1), recovered=new CountDownLatch(1);
            List<Map<String,Boolean>> retried=new ArrayList<>();
            WorkAnswerSync retry=new WorkAnswerSync(worker,batch->{ if(attempts.getAndIncrement()==0)throw new Exception("offline");retried.add(batch); },()->true,error->{if(error!=null)failure.countDown();else recovered.countDown();});
            retry.enqueue(Map.of("same",true,"keep",false)); waitFor(failure);
            retry.enqueue(Map.of("same",false,"next",true));waitFor(recovered);
            require(retried.size()==1 && retried.get(0).equals(Map.of("same",false,"keep",false,"next",true)),"failure lost or overwrote local answers");
            passed++;System.out.println("PASS retry preserves failed answers and newer edits");

            CountDownLatch writing=new CountDownLatch(1), finish=new CountDownLatch(1);List<String> order=Collections.synchronizedList(new ArrayList<>());
            WorkAnswerSync submit=new WorkAnswerSync(worker,batch->{order.add("progress");writing.countDown();waitFor(finish);},()->true,error->{});
            submit.enqueue(Map.of("q",true));waitFor(writing);submit.enqueue(Map.of("q",false));submit.pauseForSubmission();
            Future<?> finalSubmit=worker.submit(()->order.add("submit-complete-snapshot"));finish.countDown();finalSubmit.get(3,TimeUnit.SECONDS);
            require(order.equals(List.of("progress","submit-complete-snapshot")),"a stale progress write ran after submission");
            passed++;System.out.println("PASS final submission follows in-flight progress without a stale trailing write");

            AtomicInteger stale=new AtomicInteger();WorkAnswerSync oldAccount=new WorkAnswerSync(worker,batch->stale.incrementAndGet(),()->false,error->{});
            oldAccount.enqueue(Map.of("q",true));worker.submit(()->{}).get(3,TimeUnit.SECONDS);require(stale.get()==0,"old account was used");
            WorkAnswerSync closed=new WorkAnswerSync(worker,batch->stale.incrementAndGet(),()->true,error->{});closed.close();closed.enqueue(Map.of("q",true));worker.submit(()->{}).get(3,TimeUnit.SECONDS);require(stale.get()==0,"closed page still queued a save");
            passed+=2;System.out.println("PASS changed accounts and closed pages cannot enqueue saves");
            System.out.println("RESULT passed="+passed+" failed=0");
        } finally { worker.shutdownNow(); }
    }
}
