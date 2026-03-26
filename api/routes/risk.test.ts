import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import riskRoutes from './risk'

describe('risk api', () => {
  it('rejects empty materialIds', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/risk', riskRoutes)

    const res = await request(app)
      .post('/api/risk/jobs')
      .send({ materialIds: [], constants: { D: 1, C0: 1, TTS: 1, W_raw: 0.5, Cost_limit_ratio: 1.1, horizonDays: 60 } })

    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
  })
})

