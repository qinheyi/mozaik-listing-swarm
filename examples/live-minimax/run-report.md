# ListingSwarm run report

- mode                 : LIVE MiniMax-M2.7 @ https://api.minimaxi.com/v1
- SKUs                 : ESP-01, SOCK-02, LAMP-03
- agent loops          : 19  (model calls: 61, tool calls: 42, events: 336)
- peak concurrent loops: 9   peak concurrent model calls: 9
- wall-clock           : 89.4s   vs. sequential agent time 231.6s  →  2.6x parallelism

- ESP-01: published, price $54.99, compliance APPROVE
- SOCK-02: published, price $31.49, compliance REVISE → REVISE → APPROVE
- LAMP-03: published, price $44.99, compliance APPROVE

## Timeline

```mermaid
gantt
    title Agent loops running concurrently on one Mozaik runtime
    dateFormat x
    axisFormat %M:%S
    section Researcher
    ESP-01 research :1, 11586
    SOCK-02 research :2, 14520
    LAMP-03 research :3, 14161
    section Pricing
    ESP-01 pricing :2, 10728
    SOCK-02 pricing :3, 26816
    LAMP-03 pricing :4, 9899
    section SEO
    ESP-01 seo :2, 4830
    SOCK-02 seo :3, 5509
    LAMP-03 seo :4, 4389
    section Copywriter
    ESP-01 draft :11585, 17453
    LAMP-03 draft :14161, 22580
    SOCK-02 draft :14520, 22374
    SOCK-02 revise#1 :38461, 52016
    SOCK-02 revise#2 :67917, 78753
    section Compliance
    ESP-01 review#0 :17453, 40641
    SOCK-02 review#0 :22374, 38467
    LAMP-03 review#0 :22580, 39341
    SOCK-02 review#1 :52016, 67917
    SOCK-02 review#2 :78753, 89446
```

```
Researcher ESP-01  research  |████████                                                    | 11.6s
Pricing    ESP-01  pricing   |████████                                                    | 10.7s
SEO        ESP-01  seo       |████                                                        | 4.8s
Researcher SOCK-02 research  |██████████                                                  | 14.5s
Pricing    SOCK-02 pricing   |██████████████████                                          | 26.8s
SEO        SOCK-02 seo       |████                                                        | 5.5s
Researcher LAMP-03 research  |██████████                                                  | 14.2s
Pricing    LAMP-03 pricing   |███████                                                     | 9.9s
SEO        LAMP-03 seo       |███                                                         | 4.4s
Copywriter ESP-01  draft     |       █████                                                | 5.9s
Copywriter LAMP-03 draft     |         ███████                                            | 8.4s
Copywriter SOCK-02 draft     |         ███████                                            | 7.9s
Compliance ESP-01  review#0  |           █████████████████                                | 23.2s
Compliance SOCK-02 review#0  |               ███████████                                  | 16.1s
Compliance LAMP-03 review#0  |               ████████████                                 | 16.8s
Copywriter SOCK-02 revise#1  |                         ██████████                         | 13.6s
Compliance SOCK-02 review#1  |                                  ████████████              | 15.9s
Copywriter SOCK-02 revise#2  |                                             ████████       | 10.8s
Compliance SOCK-02 review#2  |                                                    ████████| 10.7s
```
