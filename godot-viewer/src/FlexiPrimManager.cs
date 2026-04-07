using Godot;
using System;
using System.Collections.Generic;
using System.Threading;

namespace PyroKitty;

/// <summary>
/// Flexi (flexible) prim simulation using Verlet integration (matching Firestorm).
/// Physics runs on a dedicated thread; main thread pushes commands and consumes
/// bone rotation output slots (one-frame delay, same pattern as animation_manager).
/// </summary>
public partial class FlexiPrimManager : RefCounted
{
    const int BoneCount = 8;
    const float MaxTensionForce = 0.99f;

    static readonly bool _debug = _InitDebug();
    static bool _InitDebug()
    {
        var env = OS.GetEnvironment("PK_DEBUG");
        if (string.IsNullOrEmpty(env)) return false;
        foreach (var tag in env.Split(','))
        {
            var t = tag.Trim().ToLowerInvariant();
            if (t == "all" || t == "flexi") return true;
        }
        return false;
    }

    // ── Flexi parameters (immutable per-prim until rebuilt) ──────────────
    struct FlexiParams
    {
        public float Tension, Drag, Gravity, Wind;
        public Vector3 UserForce;
    }

    // ── Per-section Verlet state (thread-owned) ─────────────────────────
    struct Section
    {
        public Vector3 Position;
        public Vector3 Velocity;
        public Vector3 Direction;
    }

    // ── Per-prim thread state ───────────────────────────────────────────
    class FlexiState
    {
        public Section[] Sections = new Section[BoneCount + 1];
        public FlexiParams Params;
        public float SectionLength;
        public Vector3 AnchorPos;
        public Quaternion AnchorRot;
        public Vector3 PrimScale;
    }

    // ── Output slot (thread writes, main thread reads) ──────────────────
    class OutputSlot
    {
        public readonly object Lock = new();
        public bool Ready;
        public Quaternion[] BoneRotations = new Quaternion[BoneCount + 1];
    }

    // ── Command types ───────────────────────────────────────────────────
    enum CmdType { Create, Destroy, UpdateTransform, UpdateParams, Shutdown }

    struct Command
    {
        public CmdType Type;
        public string ObjUuid;
        // Create fields
        public FlexiParams Params;
        public float SectionLength;
        public Vector3 WorldPos;
        public Quaternion WorldRot;
        public Vector3 PrimScale;
        // UpdateTransform fields
        public Vector3 NewPos;
        public Quaternion NewRot;
    }

    // ── Thread infrastructure ───────────────────────────────────────────
    Thread _thread;
    volatile bool _shuttingDown;
    readonly object _cmdLock = new();
    readonly List<Command> _cmdQueue = new();

    // Thread-owned state (only accessed from physics thread after command processing)
    readonly Dictionary<string, FlexiState> _tState = new();

    // Output slots (locked per-slot access)
    readonly object _slotsLock = new();
    readonly Dictionary<string, OutputSlot> _slots = new();

    // ── Scene tree state (main thread only) ─────────────────────────────
    readonly Dictionary<string, Node3D> _flexiRoots = new();
    readonly Dictionary<string, Skeleton3D> _flexiSkeletons = new();
    readonly Dictionary<string, MeshInstance3D> _flexiMeshes = new();

    // Back-reference to scene_manager (GDScript object)
    GodotObject _sm;

    public void Init(GodotObject sceneManager)
    {
        _sm = sceneManager;
        _thread = new Thread(PhysicsThreadLoop) { IsBackground = true, Name = "FlexiPhysics" };
        _thread.Start();
    }

    public void Shutdown()
    {
        _shuttingDown = true;
        lock (_cmdLock)
            _cmdQueue.Add(new Command { Type = CmdType.Shutdown });
        _thread?.Join(2000);
    }

    // ── Main thread API ─────────────────────────────────────────────────

    /// <summary>
    /// Create a flexi prim: builds Skeleton3D + rigged mesh on the main thread,
    /// then pushes state to the physics thread.
    /// </summary>
    public Node3D CreateFlexi(string objUuid, Godot.Collections.Dictionary paramsDict,
        Mesh primMesh, Vector3 worldPos, Quaternion worldRot, Vector3 primScale)
    {
        if (_flexiRoots.ContainsKey(objUuid))
            DestroyFlexi(objUuid);

        // Root node: position + rotation only (no scale — baked into vertices)
        var root = new Node3D();
        root.Name = $"flexi_{objUuid[..Math.Min(8, objUuid.Length)]}";
        ((Node)_sm).AddChild(root);
        root.Position = worldPos;
        root.Quaternion = worldRot;

        // Skeleton3D — bones along Y
        var skeleton = new Skeleton3D();
        skeleton.Name = "FlexiSkeleton";
        root.AddChild(skeleton);

        float flexLength = primScale.Y;
        float segmentY = flexLength / BoneCount;

        // Bone 0 = anchor at base
        skeleton.AddBone("flexi_anchor");
        skeleton.SetBoneRest(0, new Transform3D(Basis.Identity, new Vector3(0f, -flexLength * 0.5f, 0f)));

        for (int i = 0; i < BoneCount; i++)
        {
            skeleton.AddBone($"flexi_bone_{i}");
            skeleton.SetBoneParent(i + 1, i);
            skeleton.SetBoneRest(i + 1, new Transform3D(Basis.Identity, new Vector3(0f, segmentY, 0f)));
        }
        skeleton.ResetBonePoses();

        // Rigged mesh with pre-scaled vertices and bone weights
        var riggedMesh = BuildRiggedMesh(primMesh, primScale);
        var meshInst = new MeshInstance3D();
        meshInst.Name = "FlexiMesh";
        meshInst.Mesh = riggedMesh;
        meshInst.Skin = BuildSkin(skeleton);
        skeleton.AddChild(meshInst);
        meshInst.Skeleton = meshInst.GetPathTo(skeleton);

        _flexiRoots[objUuid] = root;
        _flexiSkeletons[objUuid] = skeleton;
        _flexiMeshes[objUuid] = meshInst;

        // Parse SL flexi params
        var fp = ParseParams(paramsDict);
        float sectionLength = flexLength / BoneCount;

        // Push create command to physics thread
        lock (_cmdLock)
        {
            _cmdQueue.Add(new Command
            {
                Type = CmdType.Create,
                ObjUuid = objUuid,
                Params = fp,
                SectionLength = sectionLength,
                WorldPos = worldPos,
                WorldRot = worldRot,
                PrimScale = primScale,
            });
        }

        // Create output slot
        lock (_slotsLock)
        {
            _slots[objUuid] = new OutputSlot();
        }

        if (_debug) GD.Print($"[FlexiCS] Created {objUuid[..Math.Min(8, objUuid.Length)]}: pos={worldPos} rot={worldRot} scale={primScale} bones={skeleton.GetBoneCount()} sec_len={sectionLength:F3} surfaces={riggedMesh.GetSurfaceCount()}");

        return root;
    }

    public void DestroyFlexi(string objUuid)
    {
        if (_flexiRoots.TryGetValue(objUuid, out var root))
        {
            if (GodotObject.IsInstanceValid(root))
                root.QueueFree();
        }
        _flexiRoots.Remove(objUuid);
        _flexiSkeletons.Remove(objUuid);
        _flexiMeshes.Remove(objUuid);

        lock (_slotsLock)
            _slots.Remove(objUuid);

        lock (_cmdLock)
            _cmdQueue.Add(new Command { Type = CmdType.Destroy, ObjUuid = objUuid });
    }

    public void UpdateTransform(string objUuid, Vector3 worldPos, Quaternion worldRot)
    {
        if (_flexiRoots.TryGetValue(objUuid, out var root) && GodotObject.IsInstanceValid(root))
        {
            root.Position = worldPos;
            root.Quaternion = worldRot;
        }

        lock (_cmdLock)
        {
            _cmdQueue.Add(new Command
            {
                Type = CmdType.UpdateTransform,
                ObjUuid = objUuid,
                NewPos = worldPos,
                NewRot = worldRot,
            });
        }
    }

    public MeshInstance3D GetMeshInstance(string objUuid)
    {
        return _flexiMeshes.TryGetValue(objUuid, out var mi) ? mi : null;
    }

    /// <summary>
    /// Called from scene_manager._process(). Consumes physics thread output
    /// and applies bone rotations to skeletons.
    /// </summary>
    public void ConsumeSlots()
    {
        Dictionary<string, OutputSlot> snapshot;
        lock (_slotsLock)
            snapshot = new Dictionary<string, OutputSlot>(_slots);

        foreach (var (objUuid, slot) in snapshot)
        {
            lock (slot.Lock)
            {
                if (!slot.Ready)
                    continue;

                if (_flexiSkeletons.TryGetValue(objUuid, out var skeleton)
                    && GodotObject.IsInstanceValid(skeleton))
                {
                    for (int i = 0; i <= BoneCount; i++)
                        skeleton.SetBonePoseRotation(i, slot.BoneRotations[i]);
                }

                slot.Ready = false;
            }
        }
    }

    // ── Physics thread ──────────────────────────────────────────────────

    void PhysicsThreadLoop()
    {
        while (!_shuttingDown)
        {
            // 1. Drain command queue
            List<Command> cmds;
            lock (_cmdLock)
            {
                cmds = new List<Command>(_cmdQueue);
                _cmdQueue.Clear();
            }
            foreach (var cmd in cmds)
                ProcessCommand(cmd);

            // 2. Simulate all flexi prims
            bool didWork = false;
            // Snapshot slot references
            Dictionary<string, OutputSlot> slotSnap;
            lock (_slotsLock)
                slotSnap = new Dictionary<string, OutputSlot>(_slots);

            // Compute delta from last simulation, not last loop iteration
            long now = _stopwatch.ElapsedMilliseconds;
            float delta = (_lastTickMs == 0) ? 0.016f : (now - _lastTickMs) * 0.001f;
            delta = Math.Clamp(delta, 0.001f, 0.2f);

            foreach (var (objUuid, state) in _tState)
            {
                if (!slotSnap.TryGetValue(objUuid, out var slot))
                    continue;

                // Backpressure: skip if main thread hasn't consumed yet
                lock (slot.Lock)
                {
                    if (slot.Ready)
                        continue;
                }

                SimulatePrim(state, delta);
                ComputeBoneRotations(state, slot);
                didWork = true;
            }

            // Only update timestamp when we actually simulated
            if (didWork)
                _lastTickMs = _stopwatch.ElapsedMilliseconds;

            // 3. Sleep if no work
            if (!didWork)
                Thread.Sleep(1);
        }
    }

    void ProcessCommand(Command cmd)
    {
        switch (cmd.Type)
        {
            case CmdType.Create:
            {
                var state = new FlexiState
                {
                    Params = cmd.Params,
                    SectionLength = cmd.SectionLength,
                    AnchorPos = cmd.WorldPos,
                    AnchorRot = cmd.WorldRot,
                    PrimScale = cmd.PrimScale,
                };
                InitSections(state, cmd.WorldPos, cmd.WorldRot, cmd.PrimScale);
                _tState[cmd.ObjUuid] = state;
                break;
            }
            case CmdType.Destroy:
                _tState.Remove(cmd.ObjUuid);
                break;
            case CmdType.UpdateTransform:
                if (_tState.TryGetValue(cmd.ObjUuid, out var st))
                {
                    st.AnchorPos = cmd.NewPos;
                    st.AnchorRot = cmd.NewRot;
                }
                break;
            case CmdType.UpdateParams:
                if (_tState.TryGetValue(cmd.ObjUuid, out var sp))
                    sp.Params = cmd.Params;
                break;
            case CmdType.Shutdown:
                _shuttingDown = true;
                break;
        }
    }

    static void InitSections(FlexiState state, Vector3 worldPos, Quaternion worldRot, Vector3 primScale)
    {
        float flexLength = primScale.Y;
        float sectionLength = flexLength / BoneCount;
        var direction = worldRot.Normalized() * Vector3.Up;
        var anchorPos = worldPos - direction * (flexLength * 0.5f);

        for (int i = 0; i <= BoneCount; i++)
        {
            state.Sections[i] = new Section
            {
                Position = anchorPos + direction * (sectionLength * i),
                Velocity = Vector3.Zero,
                Direction = direction,
            };
        }
    }

    // Persistent delta tracking — the physics thread runs decoupled from vsync.
    readonly System.Diagnostics.Stopwatch _stopwatch = System.Diagnostics.Stopwatch.StartNew();
    long _lastTickMs;

    void SimulatePrim(FlexiState state, float delta)
    {
        ref var sections = ref state.Sections;
        var p = state.Params;
        float sectionLength = state.SectionLength;

        // Update anchor
        var anchorDir = state.AnchorRot.Normalized() * Vector3.Up;
        float flexLength = state.PrimScale.Y;
        sections[0].Position = state.AnchorPos - anchorDir * (flexLength * 0.5f);
        sections[0].Direction = anchorDir;

        // Coefficients (matching Firestorm's doFlexibleUpdate)
        float tFactor = p.Tension * 0.1f;
        tFactor *= 1.0f - MathF.Pow(0.85f, delta * 30.0f);
        tFactor = MathF.Min(tFactor, MaxTensionForce);

        float frictionCoeff = MathF.Pow(10.0f, (p.Drag * 2.0f + 1.0f) * delta);
        frictionCoeff = MathF.Max(frictionCoeff, 1.0f);
        float momentum = 1.0f / frictionCoeff;

        float forceFactor = sectionLength * delta;
        float maxAngle = MathF.Atan(sectionLength * 2.0f);

        // Simulate sections 1..BoneCount
        for (int i = 1; i <= BoneCount; i++)
        {
            var pos = sections[i].Position;
            var vel = sections[i].Velocity;
            var lastPos = pos;

            // Gravity
            pos.Y -= p.Gravity * forceFactor;

            // User force
            pos += p.UserForce * forceFactor;

            // Tension: restoring toward parent direction
            var parentPos = sections[i - 1].Position;
            var parentDir = (i == 1) ? sections[0].Direction : sections[i - 2].Direction;

            var currentVec = pos - parentPos;
            var desiredVec = parentDir * sectionLength;
            pos += (desiredVec - currentVec) * tFactor;

            // Inertia
            pos += vel * momentum;

            // Clamp direction and distance
            var newDir = pos - parentPos;
            if (newDir.LengthSquared() < 0.0001f)
                newDir = sections[i - 1].Direction;
            else
                newDir = newDir.Normalized();

            // Angle clamp
            var parentFrameDir = sections[i - 1].Direction;
            var deltaRot = ShortestArc(parentFrameDir, newDir);
            float angle = deltaRot.GetAngle();
            if (angle > maxAngle)
            {
                var axis = deltaRot.GetAxis();
                float axisLenSq = axis.LengthSquared();
                if (axisLenSq > 0.001f)
                {
                    axis /= MathF.Sqrt(axisLenSq);
                    deltaRot = new Quaternion(axis, maxAngle);
                }
                else
                {
                    deltaRot = Quaternion.Identity;
                }
            }

            newDir = deltaRot * parentFrameDir;
            pos = parentPos + newDir * sectionLength;

            // Velocity
            vel = pos - lastPos;
            if (vel.LengthSquared() > 1.0f)
                vel = vel.Normalized();

            sections[i].Position = pos;
            sections[i].Velocity = vel;
            sections[i].Direction = newDir;
        }
    }

    /// <summary>
    /// Convert world-space section directions to per-bone pose rotations
    /// and write them to the output slot. Runs on the physics thread.
    /// </summary>
    void ComputeBoneRotations(FlexiState state, OutputSlot slot)
    {
        // Reconstruct the root basis from anchor rotation
        var accumulatedBasis = new Basis(state.AnchorRot.Normalized());

        // Bone 0 (anchor) — identity
        var rotations = slot.BoneRotations;
        rotations[0] = Quaternion.Identity;

        for (int i = 1; i <= BoneCount; i++)
        {
            var sectionDirWorld = state.Sections[i].Direction;
            var localDir = accumulatedBasis.Inverse() * sectionDirWorld;
            float localDirLen = localDir.Length();

            if (localDirLen < 0.001f)
            {
                rotations[i] = Quaternion.Identity;
            }
            else
            {
                localDir /= localDirLen;
                var poseRot = ShortestArc(Vector3.Up, localDir);
                rotations[i] = poseRot;
                accumulatedBasis = accumulatedBasis * new Basis(poseRot);
            }
        }

        lock (slot.Lock)
            slot.Ready = true;
    }

    // ── Mesh building (main thread, called once per create) ─────────────

    static ArrayMesh BuildRiggedMesh(Mesh sourceMesh, Vector3 primScale)
    {
        var rigged = new ArrayMesh();

        for (int surfIdx = 0; surfIdx < sourceMesh.GetSurfaceCount(); surfIdx++)
        {
            var arrays = sourceMesh.SurfaceGetArrays(surfIdx);
            if (arrays.Count == 0) continue;

            var vertices = arrays[(int)Mesh.ArrayType.Vertex].AsVector3Array();
            var normals = arrays[(int)Mesh.ArrayType.Normal].AsVector3Array();
            var uvs = arrays[(int)Mesh.ArrayType.TexUV].AsVector2Array();
            var indices = arrays[(int)Mesh.ArrayType.Index].AsInt32Array();

            int vertCount = vertices.Length;

            var scaledVerts = new Vector3[vertCount];
            var boneIndices = new int[vertCount * 4];
            var boneWeights = new float[vertCount * 4];

            for (int vi = 0; vi < vertCount; vi++)
            {
                var v = vertices[vi];
                scaledVerts[vi] = new Vector3(v.X * primScale.X, v.Y * primScale.Y, v.Z * primScale.Z);

                // Map unscaled vertex Y [-0.5, +0.5] to bones [0..BoneCount]
                float t = (v.Y + 0.5f) * BoneCount;
                t = Math.Clamp(t, 0f, BoneCount - 0.001f);

                int boneLo = (int)t;
                int boneHi = Math.Min(boneLo + 1, BoneCount);
                float frac = t - boneLo;

                int b = vi * 4;
                boneIndices[b] = boneLo;
                boneIndices[b + 1] = boneHi;
                boneIndices[b + 2] = 0;
                boneIndices[b + 3] = 0;
                boneWeights[b] = 1f - frac;
                boneWeights[b + 1] = frac;
                boneWeights[b + 2] = 0f;
                boneWeights[b + 3] = 0f;
            }

            var outArrays = new Godot.Collections.Array();
            outArrays.Resize((int)Mesh.ArrayType.Max);
            outArrays[(int)Mesh.ArrayType.Vertex] = scaledVerts;
            if (normals != null && normals.Length > 0)
                outArrays[(int)Mesh.ArrayType.Normal] = normals;
            if (uvs != null && uvs.Length > 0)
                outArrays[(int)Mesh.ArrayType.TexUV] = uvs;
            if (indices != null && indices.Length > 0)
                outArrays[(int)Mesh.ArrayType.Index] = indices;
            outArrays[(int)Mesh.ArrayType.Bones] = boneIndices;
            outArrays[(int)Mesh.ArrayType.Weights] = boneWeights;

            var fmt = Mesh.ArrayFormat.FormatVertex | Mesh.ArrayFormat.FormatBones | Mesh.ArrayFormat.FormatWeights;
            if (normals != null && normals.Length > 0) fmt |= Mesh.ArrayFormat.FormatNormal;
            if (uvs != null && uvs.Length > 0) fmt |= Mesh.ArrayFormat.FormatTexUV;
            if (indices != null && indices.Length > 0) fmt |= Mesh.ArrayFormat.FormatIndex;

            rigged.AddSurfaceFromArrays(Mesh.PrimitiveType.Triangles, outArrays, flags: fmt);
        }

        return rigged;
    }

    static Skin BuildSkin(Skeleton3D skeleton)
    {
        var skin = new Skin();
        for (int i = 0; i < skeleton.GetBoneCount(); i++)
            skin.AddBind(i, skeleton.GetBoneGlobalRest(i).AffineInverse());
        return skin;
    }

    static FlexiParams ParseParams(Godot.Collections.Dictionary dict)
    {
        var fp = new FlexiParams
        {
            Tension = dict.ContainsKey("tension") ? (float)dict["tension"] : 1f,
            Drag = dict.ContainsKey("drag") ? (float)dict["drag"] : 2f,
            Gravity = dict.ContainsKey("gravity") ? (float)dict["gravity"] : 0.3f,
            Wind = dict.ContainsKey("wind") ? (float)dict["wind"] : 0f,
        };
        if (dict.ContainsKey("force") && dict["force"].AsGodotArray() is { } forceArr && forceArr.Count >= 3)
            fp.UserForce = new Vector3((float)forceArr[0], (float)forceArr[1], (float)forceArr[2]);
        return fp;
    }

    /// <summary>
    /// Shortest-arc quaternion rotation from unit vector 'from' to unit vector 'to'.
    /// Matches Firestorm's LLQuaternion::shortestArc().
    /// </summary>
    static Quaternion ShortestArc(Vector3 from, Vector3 to)
    {
        float d = from.Dot(to);
        if (d > 0.9999f) return Quaternion.Identity;
        if (d < -0.9999f)
        {
            var axis = Vector3.Right.Cross(from);
            if (axis.LengthSquared() < 0.001f)
                axis = Vector3.Forward.Cross(from);
            return new Quaternion(axis.Normalized(), Mathf.Pi);
        }
        var c = from.Cross(to);
        var q = new Quaternion(c.X, c.Y, c.Z, 1f + d);
        return q.Normalized();
    }
}
