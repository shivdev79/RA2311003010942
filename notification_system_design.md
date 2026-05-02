# Campus Notifications Microservice — System Design

---

## Stage 1: REST API Design

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/notifications` | List notifications for a student (paginated) |
| `POST` | `/api/v1/notifications` | Create a notification |
| `GET` | `/api/v1/notifications/:id` | Get a single notification |
| `PATCH` | `/api/v1/notifications/:id/read` | Mark one notification as read |
| `POST` | `/api/v1/notifications/mark-all-read` | Mark all of a student's notifications as read |
| `DELETE` | `/api/v1/notifications/:id` | Delete a notification |
| `GET` | `/api/v1/notifications/priority` | Priority inbox — top N by type + recency |
| `GET` | `/api/v1/notifications/stream` | SSE stream for real-time updates |

### Request / Response Formats

**GET /api/v1/notifications**

Query params: `studentId` (required), `page=1`, `limit=20`, `isRead=false`, `type=Placement`

Headers:
```
Authorization: Bearer <token>
X-Request-ID: <uuid>  ← set by logging middleware
```

Response `200 OK`:
```json
{
  "data": [
    {
      "id": "d146095a-0d86-4a34-9e69-3900a14576bc",
      "studentId": 102,
      "type": "Placement",
      "message": "CSX Corporation hiring",
      "isRead": false,
      "createdAt": "2026-04-22T17:51:18Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

**POST /api/v1/notifications**

Request body:
```json
{
  "studentId": 102,
  "type": "Placement",
  "message": "Advanced Micro Devices Inc. hiring"
}
```

Response `201 Created`:
```json
{
  "id": "uuid",
  "studentId": 102,
  "type": "Placement",
  "message": "Advanced Micro Devices Inc. hiring",
  "isRead": false,
  "createdAt": "2026-04-22T17:05:42Z"
}
```

**PATCH /api/v1/notifications/:id/read** — `204 No Content`

**Real-time SSE — GET /api/v1/notifications/stream**

```
Content-Type: text/event-stream

event: notification
data: {"id":"uuid","type":"Placement","message":"...","createdAt":"..."}

event: notification
data: {"id":"uuid","type":"Event","message":"...","createdAt":"..."}
```

The client connects once; the server pushes new notifications as they arrive without the client needing to poll.

---

## Stage 2: Database Design

### Database Choice: PostgreSQL

**Reasons:**
- ACID transactions — critical when atomically writing DB row + queuing email
- Rich index types (B-tree, partial, composite) needed for Stage 3
- `ENUM` types enforce valid notification categories
- Window functions useful for priority-inbox queries
- `gen_random_uuid()` natively available

### Schema

```sql
CREATE TABLE students (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(255)        NOT NULL,
    email       VARCHAR(255) UNIQUE NOT NULL,
    created_at  TIMESTAMPTZ         DEFAULT NOW()
);

CREATE TYPE notification_type AS ENUM ('Placement', 'Event', 'Result');

CREATE TABLE notifications (
    id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id  BIGINT           NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    type        notification_type NOT NULL,
    message     TEXT             NOT NULL,
    is_read     BOOLEAN          NOT NULL DEFAULT FALSE,
    email_status VARCHAR(20)     NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
    -- email_status: 'pending' | 'sent' | 'failed'
);

CREATE TABLE notification_batches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message       TEXT         NOT NULL,
    target_count  INT          NOT NULL,
    sent_count    INT          NOT NULL DEFAULT 0,
    status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ  DEFAULT NOW()
    -- status: 'pending' | 'processing' | 'completed' | 'partial_failure'
);
```

### Example Query (Stage 2)

```sql
SELECT *
FROM   notifications
WHERE  student_id = 1042
  AND  is_read    = false
ORDER  BY created_at DESC;
```

---

## Stage 3: Query Performance & Indexing

### Problem at Scale

With 50,000 students and 5,000,000 notifications, the query above hits a full
sequential scan of 5 M rows (no index) → response time of several seconds.

### EXPLAIN ANALYZE (without index)

```
Seq Scan on notifications  (cost=0.00..120000.00 rows=100 width=200)
  Filter: ((student_id = 1042) AND (is_read = false))
  Rows Removed by Filter: 4,999,900
Planning time: 0.2 ms
Execution time: 3400 ms   ← unacceptable
```

### Indexing Strategy

**Index 1 — partial composite index (most important)**

```sql
CREATE INDEX idx_notif_student_unread_time
ON notifications (student_id, created_at DESC)
WHERE is_read = false;
```

- **Partial** (`WHERE is_read = false`) — indexes only ~50 % of rows; smaller, faster
- **Composite** on `(student_id, created_at DESC)` — covers the `WHERE` and `ORDER BY` in a single index scan; no separate sort step

After index creation:
```
Index Scan using idx_notif_student_unread_time on notifications
  Index Cond: (student_id = 1042)
  Rows: ~100  Planning: 0.1 ms  Execution: 0.4 ms   ← 8 500× faster
```

**Index 2 — all notifications per student (for "mark all read", history)**

```sql
CREATE INDEX idx_notif_student_time
ON notifications (student_id, created_at DESC);
```

**Index 3 — type + time (for batch queries)**

```sql
CREATE INDEX idx_notif_type_time
ON notifications (type, created_at DESC);
```

### Query: Placement Notifications in Last 7 Days

```sql
SELECT n.id, n.message, n.created_at, s.name, s.email
FROM   notifications n
JOIN   students      s ON s.id = n.student_id
WHERE  n.type       = 'Placement'
  AND  n.created_at >= NOW() - INTERVAL '7 days'
ORDER  BY n.created_at DESC;
```

Uses `idx_notif_type_time` — efficient range scan on `(type='Placement', created_at)`.

---

## Stage 4: Caching Strategy

### Problem

Every page load fires `SELECT * FROM notifications WHERE student_id = ?` → DB
hit per user per page → 50,000 concurrent users = 50,000 queries/second, DB overloaded.

### Solutions

#### 1. Redis Cache (primary)

```
GET /api/v1/notifications?studentId=1042
  → key: notif:1042:unread:page:1
  → HIT  → return cached JSON (TTL = 30 s)
  → MISS → query DB → cache result → return
```

Invalidation:
- New notification for student 1042 → `DEL notif:1042:*`
- Mark-as-read → `DEL notif:1042:*`

Also cache unread count separately: `notif:1042:unread_count` (TTL = 60 s).

#### 2. HTTP Conditional Caching

```
Response: ETag: "abc123"
Next request: If-None-Match: "abc123"
  → 304 Not Modified (no body) if data unchanged
```

Reduces bandwidth even when Redis is cold.

#### 3. Pagination (always required)

Never return all notifications. Default `limit=20`. This alone cuts DB row count
by 99 % for active students.

#### 4. Cursor-Based Pagination

Replace `OFFSET` with `WHERE created_at < :cursor` to avoid deep-page full scans.

### Trade-offs

| Strategy | Pro | Con |
|---|---|---|
| Redis cache | Dramatic DB load reduction | Stale data window, invalidation complexity |
| HTTP ETag | Zero-cost cache validation | Only helps repeat-readers, not first load |
| Pagination | Predictable query cost | UX needs scroll / "load more" |
| Cursor pagination | Stable under inserts | No random page jumps |

---

## Stage 5: Bulk Notification Architecture

### Problem

```python
function notify_all(student_ids: array, message: string):
    for student_id in student_ids:    # serial — 50 000 iterations
        send_email(student_id, message)   # 200–500 ms each, fails mid-loop
        save_to_db(student_id, message)
        push_to_app(student_id, message)
```

**Issues:**
- Serial processing: 50 000 × 400 ms ≈ 6 hours
- Email failure mid-loop leaves partial DB state (some students notified, some not)
- No retry; transient SMTP failures are permanent losses
- No observability into progress

### Redesigned Architecture

```
HR clicks "Notify All"
  ↓
1. INSERT notification_batches row (status='pending')      [DB, fast, durable]
2. Publish { batch_id, student_ids[], message } to Queue   [async, immediate ACK]
3. Return HTTP 202 Accepted + batch_id to HR               [HR isn't blocked]

Queue Worker Pool (e.g. 20 goroutines / processes):
  ↓
4. Consume batch message
5. Split student_ids into chunks of 1 000
6. For each chunk:
   a. Bulk INSERT 1 000 notifications (single SQL query, fast)
   b. Enqueue email jobs to Email Worker Pool
   c. Enqueue push jobs to Push Worker Pool (FCM/APNs batch API)
7. UPDATE notification_batches SET sent_count+=1000, status='processing'

Email Worker Pool (separate, N workers):
  ↓
8. Consume email job { student_id, message }
9. send_email()
   - Success → UPDATE notifications SET email_status='sent'
   - Failure → retry with exponential backoff (max 3 attempts)
              → on final failure: email_status='failed', log alert
```

### Should DB write and email happen together (atomically)?

**No — decouple them.**

The DB write is the source of truth. The notification exists in DB immediately.
Email is a side-effect delivery channel that is slow and fallible.
Using the **Transactional Outbox pattern**:
- DB write commits first (durable)
- A background worker reads unprocessed rows and sends email
- If the worker crashes, it restarts and re-reads — no data loss

### Improved Pseudocode

```python
# Entry point — fast, non-blocking
function notify_all(student_ids: list, message: string) -> batch_id:
    batch_id = db.insert_batch(message, len(student_ids), status='pending')
    queue.publish({ "batch_id": batch_id, "student_ids": student_ids, "message": message })
    return batch_id   # HTTP 202 Accepted

# Worker — runs in background
function process_batch(batch_id, student_ids, message):
    for chunk in split(student_ids, size=1000):
        db.bulk_insert_notifications(chunk, message, email_status='pending')
        email_queue.enqueue_batch(chunk, message)
        push_queue.enqueue_batch(chunk, message)
        db.update_batch_progress(batch_id, increment=len(chunk))

# Email worker with retry
function send_email_worker(student_id, message, attempt=1):
    try:
        smtp.send(student_id, message)
        db.update(notification, email_status='sent')
    except TransientError as e:
        if attempt <= 3:
            delay = 2 ** attempt  # 2s, 4s, 8s
            queue.schedule_retry(student_id, message, attempt+1, delay_seconds=delay)
        else:
            db.update(notification, email_status='failed')
            alert.log(f"Email permanently failed for {student_id}: {e}")
```

### Updated Schema Additions

```sql
-- Already added: email_status on notifications

CREATE TABLE email_retry_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID        NOT NULL REFERENCES notifications(id),
    attempt         INT         NOT NULL DEFAULT 1,
    next_retry_at   TIMESTAMPTZ NOT NULL,
    error_message   TEXT
);

-- Index for retry worker polling
CREATE INDEX idx_email_retry_due
ON email_retry_queue (next_retry_at)
WHERE next_retry_at <= NOW();
```

---

## Stage 6: Priority Inbox

**See `notifications/handler.go` for working implementation.**

### Algorithm — Min-Heap of size N

Priority scoring:
- `Placement` → 3
- `Result`    → 2
- `Event`     → 1

The inbox maintains a **min-heap of exactly N items**. The heap root is always the
*worst* item currently in the top-N set (lowest priority, or oldest if tied).

When a new notification arrives:
1. If `heap.size < N`: push directly → O(log N)
2. Else: compare new item vs root
   - If new item is better (higher priority, or same priority + newer timestamp):
     pop root, push new item → O(log N)
   - Otherwise: discard new item → O(1)

**Total complexity:** O(M log N) time, O(N) space for M incoming notifications.

This scales to millions of incoming notifications while keeping constant O(N) memory
and never needing to sort the full stream.

### Why not a max-heap?

A max-heap would let us peek at the best item in O(1), but we need to efficiently
**evict the worst item** when the inbox is full — that requires a min-heap whose
root is the item to evict.

### Output

`GET /api/v1/notifications/priority?n=10` returns the top-10 sorted descending:

```json
{
  "top_n": 10,
  "count": 10,
  "notifications": [
    { "id": "...", "type": "Placement", "message": "AMD hiring",       "priority_score": 3 },
    { "id": "...", "type": "Placement", "message": "CSX hiring",       "priority_score": 3 },
    { "id": "...", "type": "Result",    "message": "mid-sem",          "priority_score": 2 },
    { "id": "...", "type": "Event",     "message": "tech-fest",        "priority_score": 1 }
  ]
}
```
