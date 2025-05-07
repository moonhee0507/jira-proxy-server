type Status =
  | "AT_RISK_UNCONTROLLED"
  | "AT_RISK_UNDER_CONTROL"
  | "ON_TRACK"
  | "NONE"

type FeatureNode = {
  value: string
  children?: FeatureNode[]
}

export type Project = {
  name: string
  status: Status
  features: FeatureNode[]
}

export type ProjectFromFe = {
  uid: string
  status: Status
  name: string
  features: Delta
}

type DeltaOp = {
  insert: string
  attributes?: {
    list?: "bullet" | "ordered"
    indent?: number
  }
}

export type Delta = {
  ops: DeltaOp[]
}

export const parsedDeltaToFeatures = (delta: Delta): FeatureNode[] => {
  const stack: { node: FeatureNode; indent: number }[] = []
  const features: FeatureNode[] = []

  let currentText = ""
  let currentIndent = 0

  for (const op of delta.ops) {
    if (op.insert === "\n" && op.attributes?.list) {
      // 리스트의 끝: 하나의 항목으로 추가
      const text = currentText.trim()

      if (text) {
        const newNode: FeatureNode = { value: text }

        if (op.attributes?.indent) {
          currentIndent = op.attributes.indent
        }

        while (
          stack.length > 0 &&
          stack[stack.length - 1].indent >= currentIndent
        ) {
          stack.pop()
        }

        if (stack.length === 0) {
          features.push(newNode)
          stack.push({ node: newNode, indent: currentIndent })
        } else {
          const parent = stack[stack.length - 1].node

          if (!parent.children) {
            parent.children = []
          }

          parent.children.push(newNode)
          stack.push({ node: newNode, indent: currentIndent })
        }
      }

      currentText = ""
      currentIndent = 0
    } else if (typeof op.insert === "string") {
      currentText += op.insert.replace(/\n/g, "")
      currentIndent = op.attributes?.indent ?? 0
    }
  }

  return features
}

export const createProject = (name: string, delta: Delta): Project => {
  return {
    status: "ON_TRACK",
    name,
    features: parsedDeltaToFeatures(delta),
  }
}
