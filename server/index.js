import { createServer } from './app.js'

const port = Number(process.env.PORT || 3001)
const dbFile = process.env.DB_FILE || './server/data/catalpa.json'

const server = await createServer({ dbFile })
server.listen(port, () => {
  console.log(`[catalpa-toc] api listening on http://localhost:${port}`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
