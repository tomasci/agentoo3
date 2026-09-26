import { useState } from 'react'
import { AttachmentTrigger } from '@/shared/ui/attachment'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/shared/ui/dialog'

/**
 * An image tile's own click target and its full-size view, as one piece:
 * an `AttachmentTrigger` overlaying the whole tile (so the X action stays
 * independently clickable above it — see `attachment.tsx`'s z-20/z-10 split)
 * opens a `Dialog` showing the filename and the image at up to 70% of the
 * viewport's height. Shared by the composer's tray and the transcript's own
 * attachment tiles rather than written twice: both show the same preview for
 * the same reason, one an upload not yet sent, the other one already in the
 * transcript.
 */
export function AttachmentLightbox({
  filename,
  src,
  triggerLabel,
}: {
  filename: string
  src: string
  triggerLabel: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<AttachmentTrigger aria-label={triggerLabel} />} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{filename}</DialogTitle>
        </DialogHeader>
        <img
          src={src}
          alt={filename}
          className="mx-auto block max-h-[70vh] max-w-full rounded-sm"
        />
      </DialogContent>
    </Dialog>
  )
}
