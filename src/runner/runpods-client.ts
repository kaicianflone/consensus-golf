export class RunPodsApiError extends Error {
  constructor(message: string, public readonly errors?: unknown[]) {
    super(message)
    this.name = 'RunPodsApiError'
  }
}

export interface RunPodsConfig {
  gpuType: string
  gpuCount: number
  templateId: string
  containerImage: string
  volumeId: string
  volumeMountPath?: string
  containerDiskInGb?: number
  volumeInGb?: number
}

export interface PodInfo {
  id: string
  desiredStatus: string
  costPerHr?: number
  runtime?: {
    uptimeInSeconds?: number
    ports?: Array<{
      ip: string
      isIpPublic: boolean
      privatePort: number
      publicPort: number
      type: string
    }>
  }
}

export class RunPodsClient {
  private readonly endpoint: string

  constructor(private readonly apiKey: string) {
    this.endpoint = `https://api.runpod.io/graphql?api_key=${apiKey}`
  }

  private async graphql<T>(query: string): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) {
      throw new RunPodsApiError(`RunPods API HTTP ${res.status}: ${res.statusText}`)
    }
    const json = await res.json() as { data?: T; errors?: unknown[] }
    if (json.errors) {
      throw new RunPodsApiError(`RunPods API error: ${JSON.stringify(json.errors)}`, json.errors)
    }
    if (!json.data) {
      throw new RunPodsApiError('RunPods API returned no data')
    }
    return json.data
  }

  async createPod(config: RunPodsConfig, name: string, options?: { dockerArgs?: string; env?: Array<{ key: string; value: string }> }): Promise<string> {
    const templatePart = config.templateId ? `templateId: "${config.templateId}"` : `imageName: "${config.containerImage}"`
    const volumePart = config.volumeId ? `networkVolumeId: "${config.volumeId}"` : ''
    const volumeMountPath = config.volumeMountPath ?? '/workspace'
    const containerDisk = config.containerDiskInGb ?? 40
    const envEntries = options?.env ?? []
    const envStr = envEntries.length > 0
      ? `env: [${envEntries.map(e => `{ key: ${JSON.stringify(e.key)}, value: ${JSON.stringify(e.value)} }`).join(', ')}]`
      : ''
    const dockerArgsStr = options?.dockerArgs ? `dockerArgs: ${JSON.stringify(options.dockerArgs)}` : ''

    const query = `mutation {
      podFindAndDeployOnDemand(input: {
        cloudType: ALL
        gpuCount: ${config.gpuCount}
        containerDiskInGb: ${containerDisk}
        gpuTypeId: "${config.gpuType}"
        name: "${name}"
        ${templatePart}
        ports: "22/tcp"
        volumeMountPath: "${volumeMountPath}"
        ${volumePart}
        ${envStr}
        ${dockerArgsStr}
      }) {
        id
        desiredStatus
        costPerHr
        machine { podHostId }
      }
    }`

    const data = await this.graphql<{ podFindAndDeployOnDemand: { id: string } }>(query)
    return data.podFindAndDeployOnDemand.id
  }

  async getPodStatus(podId: string): Promise<PodInfo> {
    const query = `query {
      pod(input: { podId: "${podId}" }) {
        id
        desiredStatus
        costPerHr
        runtime {
          uptimeInSeconds
          ports {
            ip
            isIpPublic
            privatePort
            publicPort
            type
          }
        }
      }
    }`

    const data = await this.graphql<{ pod: PodInfo }>(query)
    return data.pod
  }

  async waitForRunning(podId: string, timeoutMs = 120_000, pollIntervalMs = 5_000): Promise<PodInfo> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const info = await this.getPodStatus(podId)
      if (info.desiredStatus === 'RUNNING' && info.runtime?.ports && info.runtime.ports.length > 0) {
        return info
      }
      if (info.desiredStatus === 'EXITED' || info.desiredStatus === 'ERROR') {
        throw new RunPodsApiError(`Pod ${podId} entered ${info.desiredStatus} status`)
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
    throw new RunPodsApiError(`Pod ${podId} did not reach RUNNING within ${timeoutMs}ms`)
  }

  async terminatePod(podId: string): Promise<void> {
    const query = `mutation { podTerminate(input: { podId: "${podId}" }) }`
    await this.graphql(query)
  }

  async stopPod(podId: string): Promise<void> {
    const query = `mutation { podStop(input: { podId: "${podId}" }) { id desiredStatus } }`
    await this.graphql(query)
  }

  /**
   * Get the SSH address for a pod (podHostId@ssh.runpod.io).
   * The podHostId includes a machine suffix that the SSH proxy requires.
   */
  async getSshAddress(podId: string): Promise<string> {
    const query = `query { pod(input: { podId: "${podId}" }) { machine { podHostId } } }`
    const data = await this.graphql<{ pod: { machine: { podHostId: string } } }>(query)
    return `${data.pod.machine.podHostId}@ssh.runpod.io`
  }

  /**
   * Execute a command on a running pod via SSH.
   *
   * Uses `-tt` to force PTY allocation (required by RunPods SSH proxy) and
   * pipes the command through stdin. Returns combined stdout/stderr.
   *
   * Requires ~/.ssh/id_ed25519 key registered in RunPods account settings.
   */
  async executeCommand(podId: string, command: string, timeoutMs = 900_000, sshKeyPath = '~/.ssh/id_ed25519'): Promise<string> {
    const { spawn } = await import('child_process')
    const sshAddress = await this.getSshAddress(podId)
    const resolvedKeyPath = sshKeyPath.replace('~', process.env.HOME ?? '')

    return new Promise<string>((resolve, reject) => {
      let output = ''
      const child = spawn('ssh', [
        '-tt',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=30',
        '-i', resolvedKeyPath,
        sshAddress,
        'bash',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new RunPodsApiError(`Command timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

      // Pipe the command + exit through stdin
      child.stdin?.write(command + '\nexit\n')
      child.stdin?.end()

      child.on('close', () => {
        clearTimeout(timer)
        resolve(output)
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new RunPodsApiError(`SSH error: ${err.message}`))
      })
    })
  }

  /**
   * Upload file content to a pod via base64 encoding over SSH.
   */
  async uploadScript(podId: string, content: string, remotePath: string): Promise<void> {
    const b64 = Buffer.from(content).toString('base64')
    // Split into chunks to avoid shell line length limits
    const chunkSize = 50000
    const chunks = []
    for (let i = 0; i < b64.length; i += chunkSize) {
      chunks.push(b64.slice(i, i + chunkSize))
    }

    let cmd: string
    if (chunks.length === 1) {
      cmd = `echo '${chunks[0]}' | base64 -d > ${remotePath} && echo UPLOADED $(wc -c < ${remotePath}) bytes`
    } else {
      // For large files, write chunks to a temp file then decode
      const cmds = chunks.map((chunk, i) =>
        i === 0 ? `echo '${chunk}' > /tmp/cgolf_upload.b64` : `echo '${chunk}' >> /tmp/cgolf_upload.b64`
      )
      cmds.push(`base64 -d /tmp/cgolf_upload.b64 > ${remotePath} && rm /tmp/cgolf_upload.b64 && echo UPLOADED $(wc -c < ${remotePath}) bytes`)
      cmd = cmds.join(' && ')
    }

    const output = await this.executeCommand(podId, cmd, 60_000)
    if (!output.includes('UPLOADED')) {
      throw new RunPodsApiError(`Script upload failed: ${output.slice(-200)}`)
    }
  }
}
