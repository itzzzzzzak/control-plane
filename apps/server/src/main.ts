import { syncore } from "../../../modules/syncore/index.js"

const modules = [syncore]
console.log(`controlplane: ${modules.map((m) => `${m.name} (${m.status})`).join(", ")}`)
