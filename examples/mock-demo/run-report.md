# ListingSwarm run report

- mode                 : MOCK (scripted inference runner, no API key)
- SKUs                 : ESP-01, SOCK-02, LAMP-03
- agent loops          : 21  (model calls: 49, tool calls: 28, events: 296)
- peak concurrent loops: 9   peak concurrent model calls: 9
- wall-clock           : 11.0s   vs. sequential agent time 46.2s  →  4.2x parallelism

- ESP-01: published, price $55.99, compliance REVISE → APPROVE
- SOCK-02: published, price $32.49, compliance REVISE → APPROVE
- LAMP-03: published, price $44.99, compliance REVISE → APPROVE

## Timeline

```mermaid
gantt
    title Agent loops running concurrently on one Mozaik runtime
    dateFormat x
    axisFormat %M:%S
    section Researcher
    ESP-01 research :2, 2786
    SOCK-02 research :3, 4352
    LAMP-03 research :4, 3155
    section Pricing
    ESP-01 pricing :2, 3101
    SOCK-02 pricing :3, 4326
    LAMP-03 pricing :4, 3377
    section SEO
    ESP-01 seo :3, 2076
    SOCK-02 seo :4, 1172
    LAMP-03 seo :4, 1740
    section Copywriter
    ESP-01 draft :2786, 4223
    LAMP-03 draft :3155, 4116
    SOCK-02 draft :4352, 4780
    LAMP-03 revise#1 :7230, 8046
    ESP-01 revise#1 :7559, 8281
    SOCK-02 revise#1 :8280, 9450
    section Compliance
    LAMP-03 review#0 :4116, 7230
    ESP-01 review#0 :4222, 7559
    SOCK-02 review#0 :4780, 8280
    LAMP-03 review#1 :8046, 9342
    ESP-01 review#1 :8281, 10157
    SOCK-02 review#1 :9450, 10986
```

```
Researcher ESP-01  research  |████████████████                                            | 2.8s
Pricing    ESP-01  pricing   |█████████████████                                           | 3.1s
SEO        ESP-01  seo       |████████████                                                | 2.1s
Researcher SOCK-02 research  |████████████████████████                                    | 4.3s
Pricing    SOCK-02 pricing   |████████████████████████                                    | 4.3s
SEO        SOCK-02 seo       |███████                                                     | 1.2s
Researcher LAMP-03 research  |██████████████████                                          | 3.2s
Pricing    LAMP-03 pricing   |███████████████████                                         | 3.4s
SEO        LAMP-03 seo       |██████████                                                  | 1.7s
Copywriter ESP-01  draft     |               █████████                                    | 1.4s
Copywriter LAMP-03 draft     |                 ██████                                     | 1.0s
Compliance LAMP-03 review#0  |                      ██████████████████                    | 3.1s
Compliance ESP-01  review#0  |                       ███████████████████                  | 3.3s
Copywriter SOCK-02 draft     |                       ████                                 | 0.4s
Compliance SOCK-02 review#0  |                          ████████████████████              | 3.5s
Copywriter LAMP-03 revise#1  |                                       █████                | 0.8s
Copywriter ESP-01  revise#1  |                                         █████              | 0.7s
Compliance LAMP-03 review#1  |                                           █████████        | 1.3s
Copywriter SOCK-02 revise#1  |                                             ███████        | 1.2s
Compliance ESP-01  review#1  |                                             ███████████    | 1.9s
Compliance SOCK-02 review#1  |                                                   █████████| 1.5s
```
