# 北斗监测平台 API 参考

本文档整理自北斗监测平台外部接口说明，供本项目进行第三方平台对接与工具设计时参考。仓库不保存上游 PHP 实现源码，只保留接口契约、字段含义和调用边界。

项目内使用说明：

- 本文件保留外部接口原始含义和样例，不作为本项目运行配置的唯一来源。
- 项目当前集成基址以 `.env.example` 中的 `BEIDOU_API_BASE_URL` 为准：`http://39.96.80.62/bdjc-api/v2/API`。
- 运行时不配置全局北斗账号；普通用户查询、Agent 工具、邮件订阅和定时分析必须使用当前用户或订阅所属用户绑定的北斗凭据。
- 审计日志可记录凭据使用主体和失败原因，但不得记录明文用户名密码。

## 目录

1. 北斗监测平台 API 接口概述

2. 北斗监测平台接口调用流程

3. 接口调用详细说明（含 Python 调用样例）


   1. 用户登录认证接口 —doLogin.php

   2. 获取监测点分组信息接口 —getStationGroupListInfo.php

   3. 获取监测点列表信息接口 —getStationListInfo.php

   4. 获取实时监测数据接口 —getGNSSDataInfo.php

   5. 获取日监测数据接口 —getDailyGNSSDataInfo.php

   6. 综合调用流程示例

# 一、北斗监测平台 API 接口概述

北斗监测平台是一套基于北斗卫星导航系统（GNSS）的专业化监测系统，用于对各类监测点的空间坐标数据进行实时采集、处理与存储。

本 API 接口旨在为第三方应用提供一个标准化、安全、高效的数据访问通道，支持外部系统通过 HTTP 请求方式访问平台上的监测点信息及其监测数据。

API 接口主要包含以下核心功能：

1. 用户认证与鉴权（doLogin.php）：通过调用 doLogin.php 接口，传入正确的用户名和密码，即可完成用户身份验证与会话建立。接口返回有效的 SessionUUID，用于后续所有接口请求中的身份认证。

2. 获取监测点分组信息（getStationGroupListInfo.php）：通过调用 getStationGroupListInfo.php 接口，可获取当前用户有权限访问的全部监测点分组列表信息。

3. 获取监测点列表信息（getStationListInfo.php）：通过调用 getStationListInfo.php 接口，可查询用户可访问的监测点详细信息。仅传入 SessionUUID 时，系统将返回该用户所有可访问的监测点信息；若传入特定分组的 StationGroupUUID，则可筛选指定分组下的监测点列表。

4. 获取监测点实时数据（getGNSSDataInfo.php）：通过调用 getGNSSDataInfo.php 接口，并传入监测点的 StationUUID、数据类型及起止时间等参数，可获取监测点实时 GNSS 监测数据。默认返回每分钟一条；也可通过 SamplingFrequency/SamplingInterval 或 SampleTimes/FixedTimes 调整返回粒度。

5. 获取监测点日监测数据（getDailyGNSSDataInfo.php）：通过调用 getDailyGNSSDataInfo.php 接口，传入监测点的 StationUUID 和起止时间参数，可获取日累计 GNSS 监测数据。默认返回每小时一条；也可通过 SamplingFrequency/SamplingInterval 或 SampleTimes/FixedTimes 获取每 2 小时、3 小时、6 小时或每日固定时刻的数据，用于趋势分析与长期监测。

# 二、北斗监测平台接口调用流程

北斗监测平台 API 的调用流程如下所示：

1. 认证与鉴权

   首先调用 doLogin.php 接口完成用户登录认证。在请求体中设置用户账号与密码，发起 POST 请求后，从响应结果中获取 SessionUUID。

* SessionUUID 是后续所有接口调用的身份凭证，需在请求体中携带。

* 有效期为 8 小时，在有效期内每次使用该 SessionUUID 发起请求都会自动刷新有效期。

* 若连续超过 8 小时未进行任何操作，该 SessionUUID 将失效，需重新登录获取新的会话凭证。

1. 获取监测点分组信息（可选）

   通过调用 getStationGroupListInfo.php 接口，查询当前用户可访问的监测点分组列表信息。当仅提供 SessionUUID 时，接口将返回该用户所有可访问的监测点分组。

2. 获取监测点列表信息

   调用 getStationListInfo.php 接口，根据请求参数查询可访问的监测点列表：

* 若仅提供 SessionUUID，将返回全部可访问监测点。

* 若需获取指定分组下的监测点，应先执行第 2 步，获取对应的 StationGroupUUID，再将其作为参数传入本接口。

1. 获取监测数据

   调用以下任一接口以获取监测数据：

* 实时监测数据：getGNSSDataInfo.php（默认每分钟一条数据，可选采样频率或固定每日时刻）。

* 日监测数据：getDailyGNSSDataInfo.php（默认每小时一条数据，可选采样频率或固定每日时刻）。

  请求体需包含 StationUUID 以及起止时间范围。接口将返回指定监测点在时间区间内的 GNSS 数据记录。若不传 SamplingFrequency、SamplingInterval、SampleTimes 或 FixedTimes，接口保持旧版请求格式和旧版返回行为。

# 三、接口调用详细说明（含 Python 调用样例）

## 1. 用户登录认证接口 —doLogin.php

### 接口功能

验证用户身份，返回会话凭证 SessionUUID。

### 请求 URL

POST [http://39.96.80.62/bdjc-api/API/UserLogin/doLogin.php](http://39.96.80.62/bdjc-api/API/UserLogin/doLogin.php)

### 请求参数

| 参数名称     | 是否必须 | 类型     | 描述                                                          |
| -------- | ---- | ------ | ----------------------------------------------------------- |
| Username | 是    | string | 表示用户名（可以是用户名、邮箱或手机号），用户名称格式为：以大小写字母开头的 5-32 位大小写字母或数字组成的字符。 |
| Password | 是    | string | 表示账号密码，由 12-64 位大小写字母、数字及特殊符号组成的字符串                         |

### 返回参数列表

| 返回值名称        | 类型     | 描述                |
| ------------ | ------ | ----------------- |
| ResponseCode | string | 应答代码              |
| ResponseMsg  | string | 应答消息              |
| SessionUUID  | string | 返回生成的 SessionUUID |

### 返回码说明

| 返回码    | 说明            |
| ------ | ------------- |
| 100001 | 数据库连接失败       |
| 100003 | 数据库查询错误       |
| 200    | 操作成功          |
| 400    | 操作失败          |
| 400000 | 权限不足          |
| 400100 | 会话信息格式错误      |
| 400101 | 会话无效或已过期      |
| 400110 | 账号信息格式错误      |
| 400111 | 账号名称或账号密码输入错误 |
| 400113 | 账号密码过期        |
| 400114 | 账号已被锁定或停用     |
| 400115 | 密码格式错误        |

### 请求示例

```
{

 "Username": "admin",

 "Password": "tfszMEQZawvY"

}
```

### 响应示例

```
{

   "ResponseCode": "200",

   "ResponseMsg": "操作成功",

   "SessionUUID": "bdd22dff-cd4d-335a-8033-c42c231b88af"

}
```

### Python 示例

```
def login():

   url = f"{BASE_URL}/UserLogin/doLogin.php"

   # 将用户名和密码替换为自己的用户名和密码

   payload = {"Username": "admin", "Password": "tfszMEQZawvY"}

   r = requests.post(url, headers=HEADERS, json=payload)

   print("登录结果：", json.dumps(r.json(), ensure_ascii=False, indent=2))

   return r.json().get("SessionUUID")
```

## 2. 获取监测点分组信息接口 —getStationGroupListInfo.php

### 接口功能

获取当前用户有权限访问的所有监测点分组。

### 请求 URL

POST [http://39.96.80.62/bdjc-api/API/Station/getStationGroupListInfo.php](http://39.96.80.62/bdjc-api/API/Station/getStationGroupListInfo.php)

### 请求参数

| 参数名称        | 是否必须 | 类型     | 描述                                     |
| ----------- | ---- | ------ | -------------------------------------- |
| SessionUUID | 是    | string | 会话唯一识别码，用于区分用户身份，格式为 36 个英文字符的 UUID 格式 |

### 返回参数

| 返回值名称            | 类型     | 描述                |
| ---------------- | ------ | ----------------- |
| ResponseCode     | string | 应答代码              |
| ResponseMsg      | string | 应答消息              |
| StationGroupList | array  | 监测点分组列表，每个元素的结构如下 |

#### StationGroupList 数组项结构

| 参数名称             | 类型     | 描述           |
| ---------------- | ------ | ------------ |
| StationGroupUUID | string | 监测点分组唯一识别码   |
| StationGroupName | string | 监测点分组名称      |
| StationCount     | int    | 监测点分组下监测点的数量 |
| StationGroupDesc | string | 监测点分组描述      |

### 返回码说明



| 返回码    | 说明              |
| ------ | --------------- |
| 100001 | 数据库连接失败         |
| 100003 | 数据库查询错误         |
| 200    | 操作成功            |
| 400    | 操作失败，未查询到有效用户信息 |
| 400000 | 不具备查看监测点分组列表的权限 |
| 400100 | 会话信息格式错误        |
| 400101 | 会话无效或已过期        |

### 请求示例

```
{

 "SessionUUID": "550e8400-e29b-41d4-a716-446655440000"

}
```

### 响应示例

```
{

 "ResponseCode": "200",

 "ResponseMsg": "操作成功",

 "StationGroupList": [

   {

     "StationGroupUUID": "bba7b810-9dad-11d1-80b4-00c04fd430c8",

     "StationGroupName": "北京监测组",

     "StationCount": 2,

     "StationGroupDesc": "北京市GNSS监测点分组"

   }

 ]

}
```

### Python 示例



```
def get_station_group_list_info(session_uuid):

   url = f"{BASE_URL}/Station/getStationGroupListInfo.php"

   payload = {"SessionUUID": session_uuid}

   r = requests.post(url, headers=HEADERS, json=payload)

   print("监测点分组列表：", json.dumps(r.json(), ensure_ascii=False, indent=2))

   return r.json()
```

## 3. 获取监测点列表信息接口 —getStationListInfo.php

### 接口功能

根据用户权限或分组 UUID 查询监测点列表。

### 请求 URL

POST [http://39.96.80.62/bdjc-api/API/Station/getStationListInfo.php](http://39.96.80.62/bdjc-api/API/Station/getStationListInfo.php)

### 请求参数



| 参数名称             | 是否必须 | 类型     | 描述                                                |
| ---------------- | ---- | ------ | ------------------------------------------------- |
| SessionUUID      | 是    | string | 会话唯一识别码，用于区分用户身份，格式为 36 个英文字符的 UUID 格式            |
| StationGroupUUID | 否    | string | 监测点分组唯一识别码，格式为 36 个英文字符的 UUID 格式                  |
| StationUUID      | 否    | string | 监测点唯一识别码，格式为 36 个英文字符的 UUID 格式                    |
| StationName      | 否    | string | 监测点名称，模糊匹配                                        |
| StationType      | 否    | int    | 监测点类型（1 = 基准站，2 = 移动站单点模式，3 = 移动站 RTK 模式，4 = 中继站） |
| StationStatus    | 否    | int    | 监测点状态 (10 = 正常，20 = 离线，30 = 告警，40 = 故障)           |
| PageInfo         | 否    | object | 分页信息                                              |

#### PageInfo 结构



| 参数名称       | 类型     | 描述                                                 |
| ---------- | ------ | -------------------------------------------------- |
| PageFlag   | string | 排序依据，格式为请求参数 + 排序规则，默认为 'StationNameAsc'，即按监测点名称升序 |
| PageNumber | int    | 获取第几页的数据，默认为 1                                     |
| PageSize   | int    | 一页展示的数据，默认为 10，当 PageSize 为 - 1 时获取全部              |

### 返回参数



| 返回值名称        | 类型     | 描述              |
| ------------ | ------ | --------------- |
| ResponseCode | string | 应答代码            |
| ResponseMsg  | string | 应答消息            |
| PageInfo     | object | 分页信息            |
| StationList  | array  | 监测点列表，每个元素的结构如下 |

#### PageInfo 结构



| 参数名称        | 类型     | 描述                                                 |
| ----------- | ------ | -------------------------------------------------- |
| PageFlag    | string | 排序依据，格式为请求参数 + 排序规则，默认为 'StationNameAsc'，即按监测点名称升序 |
| PageNumber  | int    | 获取第几页的数据                                           |
| PageSize    | int    | 一页展示的数据                                            |
| TotalNumber | int    | 数据总数                                               |

#### StationList 数组项结构



| 参数名称             | 类型     | 描述                                                |
| ---------------- | ------ | ------------------------------------------------- |
| StationGroupUUID | string | 监测点分组唯一识别码                                        |
| StationGroupName | string | 监测点分组名称                                           |
| StationUUID      | string | 监测点唯一识别码                                          |
| DeviceUUID       | string | 设备唯一识别码                                           |
| StationName      | string | 监测点名称                                             |
| StationN0        | string | 监测点初始北向坐标（单位：m）                                   |
| StationE0        | string | 监测点初始东向坐标（单位：m）                                   |
| StationU0        | string | 监测点初始海拔高度（单位：m）                                   |
| StationType      | int    | 监测点类型（1 = 基准站，2 = 移动站单点模式，3 = 移动站 RTK 模式，4 = 中继站） |
| StationLocation  | string | 监测点地址                                             |
| StationStatus    | int    | 监测点状态 (10 = 正常，20 = 离线，30 = 告警，40 = 故障)           |
| StationDesc      | string | 监测点描述                                             |
| BaseStationUUID  | string | 监测点绑定基准站的唯一识别码                                    |
| BaseStationName  | string | 监测点绑定基准站的名称                                       |
| Latitude         | string | 监测点在地图中的定位纬度（WGS84 坐标系，十进制度格式）                    |
| Longitude        | string | 监测点在地图中的定位经度（WGS84 坐标系，十进制度格式）                    |
| Altitude         | string | 监测点在地图中的海拔高度（单位：m）                                |

### 返回码说明



| 返回码    | 说明              |
| ------ | --------------- |
| 100001 | 数据库连接失败         |
| 100003 | 数据库查询错误         |
| 200    | 操作成功            |
| 400    | 操作失败，未查询到有效用户信息 |
| 400000 | 不具备查看监测点列表的权限   |
| 400100 | 会话信息格式错误        |
| 400101 | 会话无效或已过期        |

### 请求示例



```
{

 "SessionUUID": "550e8400-e29b-41d4-a716-446655440000",

 "StationGroupUUID": "8ba7b810-9dad-11d1-80b4-00c04fd430c8",

 "StationName": "北京监测点",

 "StationStatus": 10,

 "StationType": 1,

 "PageInfo": {

   "PageFlag": "StationNameAsc",

   "PageNumber": 1,

   "PageSize": 10

 }

}
```

### 响应示例



```
{

 "ResponseCode": "200",

 "ResponseMsg": "操作成功",

 "PageInfo": {

   "PageFlag": "StationNameAsc",

   "PageNumber": 1,

   "PageSize": 10,

   "TotalNumber": 1

 },

 "StationList": [

   {

     "StationGroupUUID": "8ba7b810-9dad-11d1-80b4-00c04fd430c8",

     "StationGroupName": "北京设备组",

     "StationUUID": "aba7b810-9dad-11d1-80b4-00c04fd430c8",

     "DeviceUUID": "aba7b810-9dad-11d1-80b4-00c04fd430c8",

     "StationName": "北京监测点001",

     "StationN0": "4421290.4231",

     "StationE0": "198942.5203",

     "StationU0": "17.2676",

     "StationType": 1,

     "StationLocation": "北京市海淀区",

     "StationStatus": 10,

     "StationDesc": "北京市海淀区GNSS监测点",

     "BaseStationUUID": "cba7b810-9dad-11d1-80b4-00c04fd430c8",

     "BaseStationName": "北京基准站001",

     "Latitude": "39.759630522",

     "Longitude": "116.986252277",

     "Altitude": "44.2287"

   }

 ]

}
```

### Python 示例



```
def get_station_list_info(session_uuid):

   url = f"{BASE_URL}/Station/getStationListInfo.php"

   payload = {

       "SessionUUID": session_uuid,

       "PageInfo": {

           "PageFlag": "StationNameAsc",

           "PageNumber": 1,

           "PageSize": 10

       }

   }

   r = requests.post(url, headers=HEADERS, json=payload)

   print("监测点列表：", json.dumps(r.json(), ensure_ascii=False, indent=2))

   return r.json()
```

## 4. 获取实时监测数据接口 —getGNSSDataInfo.php

### 接口功能

查询指定监测点的实时 GNSS 数据，默认每分钟一条。可通过 SamplingFrequency 调整为每 5 分钟、30 分钟、1 小时、2 小时、3 小时、6 小时等粒度，也可通过 SampleTimes 获取每天固定时刻（如 03:00、15:00）的记录。注意：该接口的起止时间不允许跨天（例如：2025-02-10 00:00:00 至 2025-02-10 23:59:59 正确，2025-02-10 05:00:00 至 2025-02-11 05:00:00 错误）。

### 请求 URL

POST [http://39.96.80.62/bdjc-api/API/GNSSData/getGNSSDataInfo.php](http://39.96.80.62/bdjc-api/API/GNSSData/getGNSSDataInfo.php)

### 请求参数

| 参数名称        | 是否必须 | 类型     | 描述                                            |
| ----------- | ---- | ------ | --------------------------------------------- |
| SessionUUID | 是    | string | 表示会话唯一编码，用于区分用户身份和权限鉴别，格式为 36 个英文字符的 UUID 格式。 |
| StationUUID | 是    | string | 监测点唯一编码，格式为 36 个英文字符的 UUID 格式                 |
| DataType    | 否    | int    | 数据类型（1=PJKEST，2=PJKFIR），不传时默认 DataType=1 |
| BeginTime   | 是    | string | 起始时间（格式：YYYY-MM-DD HH:mm:ss）                  |
| EndTime     | 是    | string | 结束时间（格式：YYYY-MM-DD HH:mm:ss）                  |
| SamplingFrequency | 否 | int/string | 采样频率。支持整数分钟（如 60）或带单位字符串（如 "60m"、"1h"、"2h"、"3h"、"6h"、"every 6 hours"）。不传时保持旧行为，返回原始每分钟数据。 |
| SamplingInterval | 否 | int/string | SamplingFrequency 的兼容别名；当 SamplingFrequency 为空或未传时生效。 |
| SampleTimes | 否 | array/string | 固定每日取样时间。支持数组（如 ["03:00","15:00"]、["daily 03:00","daily 15:00"]）或英文逗号分隔字符串（如 "03:00,15:00"）。传入后优先于 SamplingFrequency。 |
| FixedTimes | 否 | array/string | SampleTimes 的兼容别名；当 SampleTimes 为空或未传时生效。 |

兼容说明：

* 旧版请求只包含 SessionUUID、StationUUID、DataType、BeginTime、EndTime 时，返回结果与旧版一致，不做降采样；DataType 省略时仍按旧行为默认使用 PJKEST（DataType=1）。
* SamplingInterval 是 SamplingFrequency 的兼容别名；FixedTimes 是 SampleTimes 的兼容别名。
* 同时传入 SamplingFrequency/SamplingInterval 和 SampleTimes/FixedTimes 时，接口按 SampleTimes/FixedTimes 固定每日时刻过滤；固定时刻有效时，不因同时存在的频率参数无效而失败。
* SamplingFrequency 按每天 00:00 对齐，例如 "2h" 返回 00:00、02:00、04:00 等时间点；"6h" 返回 00:00、06:00、12:00、18:00 等时间点。
* SampleTimes 接受 HH:mm、HH:mm:ss 或带 daily 前缀的表达（如 "daily 03:00"），接口会规范化为 HH:mm:ss 后匹配数据时间。

### 返回参数

| 返回值名称        | 类型     | 描述               |
| ------------ | ------ | ---------------- |
| ResponseCode | string | 应答代码             |
| ResponseMsg  | string | 应答消息             |
| Data         | array  | 数据信息列表，每个元素的结构如下 |

#### Data 数组项结构

| 参数名称          | 类型     | 描述                           |
| ------------- | ------ | ---------------------------- |
| DataTime      | string | 数据时间（格式：YYYY-MM-DD HH:mm:ss） |
| DataTimestamp | long   | 数据时间戳                        |
| PJKInfoN      | string | 北向坐标值（单位：m）                  |
| PJKInfoE      | string | 东向坐标值（单位：m）                  |
| PJKInfoU      | string | 垂直坐标值（单位：m）                  |

### 返回码说明

| 返回码    | 说明       |
| ------ | -------- |
| 100001 | 数据库连接失败  |
| 100003 | 数据库查询错误  |
| 200    | 操作成功     |
| 400    | 操作失败     |
| 400000 | 权限不足     |
| 400100 | 会话信息格式错误 |
| 400101 | 会话无效或已过期 |

### 请求示例

```
{

 "SessionUUID": "550e8400-e29b-41d4-a716-446655440000",

 "StationUUID": "24db1004-b58f-4965-a9bc-5ae0bdaf0c6f",

 "DataType":1,

 "BeginTime": "2025-02-10 00:00:00",

 "EndTime": "2025-02-10 00:02:59"

}
```

按采样频率请求示例（每 1 小时一条）：

```
{

 "SessionUUID": "550e8400-e29b-41d4-a716-446655440000",

 "StationUUID": "24db1004-b58f-4965-a9bc-5ae0bdaf0c6f",

 "DataType": 1,

 "BeginTime": "2025-02-10 00:00:00",

 "EndTime": "2025-02-10 23:59:59",

 "SamplingFrequency": "1h"

}
```

按固定每日时刻请求示例：

```
{

 "SessionUUID": "550e8400-e29b-41d4-a716-446655440000",

 "StationUUID": "24db1004-b58f-4965-a9bc-5ae0bdaf0c6f",

 "DataType": 1,

 "BeginTime": "2025-02-10 00:00:00",

 "EndTime": "2025-02-10 23:59:59",

 "SampleTimes": ["daily 03:00", "daily 15:00"]

}
```

### 响应示例

```
{

   "ResponseCode": "200",

   "ResponseMsg": "操作成功",

   "Data": [

       {

           "DataTime":"2025-08-18 00:01:00",

           "DataTimestamp":1755446460,

           "PJKInfoN":"3533124.543",

           "PJKInfoE":"380614.993",

           "PJKInfoU":"213.655"

       },

       {

           "DataTime":"2025-08-18 00:02:00",

           "DataTimestamp":1755446520,

           "PJKInfoN":"3533124.550",

           "PJKInfoE":"380615.007",

           "PJKInfoU":"213.599"

       },

       {

           "DataTime":"2025-08-18 00:03:00",

           "DataTimestamp":1755446580,

           "PJKInfoN":"3533124.550",

           "PJKInfoE":"380615.005",

           "PJKInfoU":"213.576"

       }

   ]

}
```

### Python 示例

```
def get_gnss_data(session_uuid, station_uuid, sampling_frequency=None, sample_times=None):

   url = f"{BASE_URL}/GNSSData/getGNSSDataInfo.php"

   payload = {

       "SessionUUID": session_uuid,

       "StationUUID": station_uuid,

       "DataType": 1,

       "BeginTime": "2025-02-10 00:00:00",

       "EndTime": "2025-02-10 00:02:59"

   }

   if sampling_frequency:

       payload["SamplingFrequency"] = sampling_frequency

   if sample_times:

       payload["SampleTimes"] = sample_times

   r = requests.post(url, headers=HEADERS, json=payload)

   print("实时监测数据：", json.dumps(r.json(), ensure_ascii=False, indent=2))

   return r.json()
```

## 5. 获取日监测数据接口 —getDailyGNSSDataInfo.php

### 接口功能

查询指定监测点的日监测数据，默认每小时一条。可通过 SamplingFrequency 调整为每 2 小时、3 小时、6 小时等粒度，也可通过 SampleTimes 获取每天固定时刻（如 03:00、15:00）的记录。

### 请求 URL

POST [http://39.96.80.62/bdjc-api/API/GNSSData/getDailyGNSSDataInfo.php](http://39.96.80.62/bdjc-api/API/GNSSData/getDailyGNSSDataInfo.php)

### 请求参数



| 参数名称        | 是否必须 | 类型     | 描述                                            |
| ----------- | ---- | ------ | --------------------------------------------- |
| SessionUUID | 是    | string | 表示会话唯一编码，用于区分用户身份和权限鉴别，格式为 36 个英文字符的 UUID 格式。 |
| StationUUID | 是    | string | 监测点唯一编码，格式为 36 个英文字符的 UUID 格式                 |
| BeginTime   | 是    | string | 起始时间（格式：YYYY-MM-DD HH:mm:ss）                  |
| EndTime     | 是    | string | 结束时间（格式：YYYY-MM-DD HH:mm:ss）                  |
| SamplingFrequency | 否 | int/string | 采样频率。支持整数分钟（如 120）或带单位字符串（如 "1h"、"2h"、"3h"、"6h"、"every 6 hours"）。不传时保持旧行为，返回原始每小时数据。 |
| SamplingInterval | 否 | int/string | SamplingFrequency 的兼容别名；当 SamplingFrequency 为空或未传时生效。 |
| SampleTimes | 否 | array/string | 固定每日取样时间。支持数组（如 ["03:00","15:00"]、["daily 03:00","daily 15:00"]）或英文逗号分隔字符串（如 "03:00,15:00"）。传入后优先于 SamplingFrequency。 |
| FixedTimes | 否 | array/string | SampleTimes 的兼容别名；当 SampleTimes 为空或未传时生效。 |

兼容说明：

* 旧版请求只包含 SessionUUID、StationUUID、BeginTime、EndTime 时，返回结果与旧版一致，不做降采样。
* SamplingInterval 是 SamplingFrequency 的兼容别名；FixedTimes 是 SampleTimes 的兼容别名。
* 同时传入 SamplingFrequency/SamplingInterval 和 SampleTimes/FixedTimes 时，接口按 SampleTimes/FixedTimes 固定每日时刻过滤；固定时刻有效时，不因同时存在的频率参数无效而失败。
* SamplingFrequency 按每天 00:00 对齐，例如 "2h" 返回 00:00、02:00、04:00 等时间点；"6h" 返回 00:00、06:00、12:00、18:00 等时间点。
* 日监测数据源默认是小时级数据，传入小于 1 小时的 SamplingFrequency 不会生成额外半小时或分钟级记录，只会从已有小时级记录中筛选匹配时间点。
* SampleTimes 接受 HH:mm、HH:mm:ss 或带 daily 前缀的表达（如 "daily 03:00"），接口会规范化为 HH:mm:ss 后匹配数据时间。

### 返回参数

| 返回值名称        | 类型     | 描述               |
| ------------ | ------ | ---------------- |
| ResponseCode | string | 应答代码             |
| ResponseMsg  | string | 应答消息             |
| Data         | array  | 数据信息列表，每个元素的结构如下 |

#### Data 数组项结构

| 参数名称          | 类型     | 描述                           |
| ------------- | ------ | ---------------------------- |
| DataTime      | string | 数据时间（格式：YYYY-MM-DD HH:mm:ss） |
| DataTimestamp | long   | 数据时间戳                        |
| PJKInfoN      | string | 北向坐标值（单位：m）                  |
| PJKInfoE      | string | 东向坐标值（单位：m）                  |
| PJKInfoU      | string | 垂直坐标值（单位：m）                  |

### 返回码说明

| 返回码    | 说明       |
| ------ | -------- |
| 100001 | 数据库连接失败  |
| 100003 | 数据库查询错误  |
| 200    | 操作成功     |
| 400    | 操作失败     |
| 400000 | 权限不足     |
| 400100 | 会话信息格式错误 |
| 400101 | 会话无效或已过期 |

### 请求示例

```
{

 "SessionUUID": "550e8400-e29b-41d4-a716-446655440000",

 "StationUUID": "24db1004-b58f-4965-a9bc-5ae0bdaf0c6f",

 "BeginTime": "2025-02-10 00:00:00",

 "EndTime": "2025-02-10 02:59:59"

}
```

按采样频率请求示例（每 6 小时一条）：

```
{

 "SessionUUID": "550e8400-e29b-41d4-a716-446655440000",

 "StationUUID": "24db1004-b58f-4965-a9bc-5ae0bdaf0c6f",

 "BeginTime": "2025-02-10 00:00:00",

 "EndTime": "2025-02-10 23:59:59",

 "SamplingFrequency": "6h"

}
```

按固定每日时刻请求示例：

```
{

 "SessionUUID": "550e8400-e29b-41d4-a716-446655440000",

 "StationUUID": "24db1004-b58f-4965-a9bc-5ae0bdaf0c6f",

 "BeginTime": "2025-02-10 00:00:00",

 "EndTime": "2025-02-12 23:59:59",

 "SampleTimes": ["daily 03:00", "daily 15:00"]

}
```

### 响应示例

```
{

   "ResponseCode": "200",

   "ResponseMsg": "操作成功",

   "Data": [

       {

           "DataTime":"2025-02-10 00:00:00",

           "DataTimestamp":1739116800,

           "PJKInfoN":"3269234.5775",

           "PJKInfoE":"572757.6600",

           "PJKInfoU":"44.0022"

       },

       {

           "DataTime":"2025-02-10 01:00:00",

           "DataTimestamp":1739120400,

           "PJKInfoN":"3269234.5761",

           "PJKInfoE":"572757.6587",

           "PJKInfoU":"43.9995"

       },

       {

           "DataTime":"2025-02-10 02:00:00",

           "DataTimestamp":1739124000,

           "PJKInfoN":"3269234.5781",

           "PJKInfoE":"572757.6577",

           "PJKInfoU":"43.9992"

       }

   ]

}
```

### Python 示例

```
def get_daily_gnss_data(session_uuid, station_uuid, sampling_frequency=None, sample_times=None):

   url = f"{BASE_URL}/GNSSData/getDailyGNSSDataInfo.php"

   payload = {

       "SessionUUID": session_uuid,

       "StationUUID": station_uuid,

       "BeginTime": "2025-02-10 00:00:00",

       "EndTime": "2025-02-10 02:59:59"

   }

   if sampling_frequency:

       payload["SamplingFrequency"] = sampling_frequency

   if sample_times:

       payload["SampleTimes"] = sample_times

   r = requests.post(url, headers=HEADERS, json=payload)

   print("日监测数据：", json.dumps(r.json(), ensure_ascii=False, indent=2))

   return r.json()
```

## 6. 综合调用流程示例

```
if __name__ == "__main__":

   # Step 1: 登录获取 SessionUUID

   session_uuid = login()

   # Step 2: 获取监测点分组信息

   group_info = get_station_group_list_info(session_uuid)

   # Step 3: 获取监测点列表信息

   station_info = get_station_list_info(session_uuid)

   # Step 4: 选取一个监测点 UUID 示例

   if station_info.get("StationList"):

       sample_station_uuid = station_info["StationList"][0]["StationUUID"]

       # Step 5: 获取实时监测数据

       get_gnss_data(session_uuid, sample_station_uuid)

       # Step 6: 获取日监测数据

       get_daily_gnss_data(session_uuid, sample_station_uuid)
```
