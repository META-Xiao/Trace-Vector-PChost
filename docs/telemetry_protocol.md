# 图传混合协议设计文档

## 1. 协议概览

**目标**：统一传输图像、日志、资源信息，供上位机实时显示与分析

**通道配置**
- 波特率: 115200 bps，帧格式 8N1
- 通道: USB-CDC / UART（无线转串口）
- 编码: 二进制多帧混合协议

---

## 2. 帧类型定义

### 2.1 图传帧 (0xCC)

**帧结构**:
```
┌─────┬───────┬─────────┬──────────┬───────┬────────┬──────────────┬──────────┐
│ ID  │ Frame │ FPS_cam │ FPS_out  │ Width │ Height │ ImageData    │ Checksum │
├─────┼───────┼─────────┼──────────┼───────┼────────┼──────────────┼──────────┤
│ 0xCC│ (2B)  │ (1B)    │ (1B)     │ (1B)  │ (1B)   │ (W×H bytes)  │ (1B)     │
└─────┴───────┴─────────┴──────────┴───────┴────────┴──────────────┴──────────┘
```

**字段说明**:
- `Frame`: 帧计数器（0-65535，uint16 大端）
- `FPS_cam`: 摄像头实际帧率
- `FPS_out`: 图传输出帧率
- `Width`: 图像宽度（像素，uint8）
- `Height`: 图像高度（像素，uint8）
- `ImageData`: 原始灰度图像，逐行存储，共 Width×Height 字节
- `Checksum`: 所有字节之和 & 0xFF（含帧头 0xCC）

**总字节数**: 9 + W×H（例：188×120 → 22569B）  
**上位机处理**: 从帧头读取 Width/Height 动态分配缓冲区，图像解析→Canvas 显示

---

### 2.2 日志帧 (0xDD)

**帧结构**:
```
┌─────┬────────┬────────────┬──────────┐
│ ID  │ Length │ LogData    │ Checksum │
├─────┼────────┼────────────┼──────────┤
│ 0xDD│ (2B)   │ (0-256B)   │ (1B)     │
└─────┴────────┴────────────┴──────────┘
```

**字段说明**:
- `Length`: 日志数据字节数（uint16 大端，最大 256）
- `LogData`: UTF-8 文本内容
- `Checksum`: 所有字节之和 & 0xFF（含帧头 0xDD）

**总字节数**: 4 + N（N=0-256）  
**上位机处理**: 文本解析→控制台显示

---

### 2.3 资源帧 (0xEE)

**帧结构**:
```
┌─────┬──────────┬──────────┬──────────┬───────────┬──────────┬────────────┬──────────────┬──────────┬──────────┐
│ ID  │ CPUUsage │ RAMUsage │ FreeHeap │ FreeStack │ RamTotal │ Speed      │ ServoAngle   │ Reserved │ Checksum │
├─────┼──────────┼──────────┼──────────┼───────────┼──────────┼────────────┼──────────────┼──────────┼──────────┤
│ 0xEE│ (1B) %   │ (1B) %   │ (2B)     │ (2B)      │ (2B)     │ (2B int16) │ (2B int16)   │ (4B)     │ (1B)     │
└─────┴──────────┴──────────┴──────────┴───────────┴──────────┴────────────┴──────────────┴──────────┴──────────┘
```

**字段说明**:
- `CPUUsage`: CPU 占用率（%，uint8，范围 0-100）
- `RAMUsage`: RAM 占用率（%，uint8，范围 0-100）
- `FreeHeap`: 堆剩余字节数（uint16 大端）
- `FreeStack`: 栈剩余字节数（uint16 大端）
- `RamTotal`: MCU 自报总内存字节数（uint16 大端）
- `Speed`: 前进速度（mm/s，int16 大端，正=前进，负=后退）
- `ServoAngle`: 舵机偏转角度（int16 大端，单位由 MCU 定义）
- `Reserved`: 预留 4 字节，填 0
- `Checksum`: 所有字节之和 & 0xFF（含帧头 0xEE）

**总字节数**: 18B（1+1+1+2+2+2+2+2+4+1）  
**上位机计算**:
```javascript
ram_used_pct = RAMUsage;                          // RAM 占用率 %
heap_used    = RamTotal - FreeHeap;               // 已用堆字节数
stack_used   = RamTotal - FreeStack;              // 已用栈字节数
speed_ms     = Speed / 1000.0;                    // 速度 m/s
```

---

## 3. 校验和算法

所有帧的校验和计算方式相同：将帧内**所有字节**（含帧头 ID 字节）逐一累加，取低 8 位。

```
checksum = (byte[0] + byte[1] + ... + byte[N-1]) & 0xFF
```

校验和字节本身不参与计算，位于帧末尾。

---

## 4. 帧同步与错误恢复

上位机解析时，以帧头字节（0xCC / 0xDD / 0xEE）作为同步标志：

1. 逐字节扫描，遇到已知帧头则开始解析对应帧
2. 若校验和不匹配，丢弃该帧，继续向后扫描下一个帧头
3. 未知字节直接跳过

---

## 5. 时序参考

115200 bps 下各帧传输耗时（含帧头和校验和）：

| 帧类型 | 典型大小 | 传输耗时 |
|--------|----------|----------|
| 图传帧 (0xCC) | 22569B（188×120） | ≈ 1960ms |
| 日志帧 (0xDD) | 4–260B | < 23ms |
| 资源帧 (0xEE) | 18B | < 2ms |

图传帧体积远大于其他帧，MCU 端建议使用异步/DMA 发送以避免阻塞。

---

## 6. 上位机解析伪代码

```python
while True:
    byte = read_byte()

    if byte == 0xCC:          # 图传帧
        frame_id  = read_uint16_be()
        fps_cam   = read_uint8()
        fps_out   = read_uint8()
        width     = read_uint8()
        height    = read_uint8()
        pixels    = read_bytes(width * height)
        checksum  = read_uint8()
        # 验证校验和后显示图像

    elif byte == 0xDD:        # 日志帧
        length    = read_uint16_be()   # 最大 256
        log_data  = read_bytes(length)
        checksum  = read_uint8()
        # 验证校验和后输出 UTF-8 文本

    elif byte == 0xEE:        # 资源帧
        cpu       = read_uint8()
        ram       = read_uint8()
        free_heap = read_uint16_be()
        free_stk  = read_uint16_be()
        ram_total = read_uint16_be()
        speed     = read_int16_be()
        servo     = read_int16_be()
        reserved  = read_bytes(4)
        checksum  = read_uint8()
        # 验证校验和后更新仪表板
```

---

**文档版本**: 2.0  
**更新日期**: 2026-05-24
