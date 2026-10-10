-- Allow image/heif in the documents bucket (photos are normally converted to JPEG in the browser before upload).
update storage.buckets
set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
where id = 'documents';
