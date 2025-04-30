type Status = 'AT_RISK_UNCONTROLLED' | 'AT_RISK_UNDER_CONTROL' | 'ON_TRACK';

type FeatureNode = {
    value: string;
    children?: FeatureNode[];
}

type Project = {
    name: string;
    status: Status;
    features: FeatureNode[];
}

type DeltaOp = {
    insert: string
    attributes?: {
        list?: 'bullet' | 'ordered'
        indent?: number
    }
}

type Delta = {
    ops: DeltaOp[]
}

export const parsedDeltaToFeatures = (delta: Delta): FeatureNode[] => {
    const stack: { node: FeatureNode, indent: number }[] = []
    const features: FeatureNode[] = []

    delta.ops.forEach((op) => {
        if (!op.insert.trim()) return; // Skip empty blocks

        const text = op.insert.trim()
        const indent = op.attributes?.indent ?? 0

        const newNode: FeatureNode = { value: text }

        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
            stack.pop()
        }

        if (stack.length === 0) {
            // 최상위 Feature
            features.push(newNode)
            stack.push({ node: newNode, indent })
        } else {
            // 가장 가까운 부모의 children으로 추가
            const parent = stack[stack.length - 1].node
            if (!parent.children) {
                parent.children = []
            }
            parent.children.push(newNode)
            stack.push({ node: newNode, indent })
        }
    })

    return features
}

export const createProject = (name: string, delta: Delta): Project => {
    return {
        status: 'ON_TRACK',
        name,
        features: parsedDeltaToFeatures(delta)
    }
}