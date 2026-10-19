# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-19

### Added
- Carousel selection feature with instant band movement
- Month-strip tracking with restore
- Slide-aware selection policy (picture is the target)
- Selection receipt recording for band moves

### Changed
- Replaced "never move a band" assertion with new "picture is the target" policy
- Updated `revealCarouselSlide` to move band to change's own slide
- Improved month-strip sync/restore on selection

### Fixed
- Deselect restores band transform and strip exactly
- Click sweep: all sampled rows land correctly

### Test Results
- 294/294 tests passing
- Exit code 0 on all checks