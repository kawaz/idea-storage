import { define } from 'gunshi'
import { runEnqueue } from './session-enqueue.ts'
import { runProcess } from './session-process.ts'

const sessionRun = define({
  name: 'run',
  description: 'Enqueue sessions then process until queue is empty',
  run: async () => {
    await runEnqueue()

    // Process until queue is empty
    while (await runProcess()) {
      // continue processing
    }
  },
})

export default sessionRun
