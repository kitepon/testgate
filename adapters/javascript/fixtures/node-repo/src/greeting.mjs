import { readFileSync } from 'node:fs'

const template = readFileSync(new URL('../templates/hello.txt', import.meta.url), 'utf8').trim()

export function greet(name) {
  return template.replace('{name}', name)
}
