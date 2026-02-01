import { define } from 'gunshi'
import { getStatus } from '../lib/queue.ts'

const sessionStatus = define({
  name: 'status',
  description: 'Show queue status',
  run: async () => {
    const status = await getStatus()
    console.log(`Queued: ${status.queued} / Done: ${status.done} / Failed: ${status.failed}`)
  },
})

export default sessionStatus
